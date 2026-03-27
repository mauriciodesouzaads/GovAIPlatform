/**
 * Execution Service — Core AI governance pipeline for /v1/execute/:assistantId.
 *
 * Extracted from server.ts to improve testability, readability, and separation of concerns.
 * The route handler in server.ts is now a thin adapter that delegates here.
 *
 * Pipeline order (correct):
 *   1. fetch policy rules (must precede governance evaluation)
 *   2. org query  (single DB round-trip: telemetry + hitl_timeout_hours)
 *   3. opaEngine.evaluate (OPA + DLP — governance first)
 *   4. HITL check  (PENDING_APPROVAL returns before FinOps)
 *   5. BLOCK check (policy violation returns before FinOps)
 *   6. DLP flag
 *   7. checkQuota (FinOps — only reached if request is allowed)
 *   8. RAG
 *   9. LLM dispatch
 */

import { FastifyBaseLogger } from 'fastify';
import { PoolClient } from 'pg';
import axios from 'axios';
import { createHash } from 'crypto';
import { IntegrityService, ActionType } from '../lib/governance';
import { opaEngine } from '../lib/opa-governance';
import { dlpEngine } from '../lib/dlp-engine';
import { auditQueue } from '../workers/audit.worker';
import { notificationQueue } from '../workers/notification.worker';
import { telemetryQueue } from '../workers/telemetry.worker';
import { recordRequest, recordDlpDetection, assistantLatencyHistogram } from '../lib/sre-metrics';
import { checkQuota, recordTokenUsage, getCostPerToken } from '../lib/finops';
import { pgPool } from '../lib/db';
import { redisCache } from '../lib/redis';
import { recordEvidence } from '../lib/evidence';

export interface ExecutionParams {
    assistantId: string;
    orgId: string;
    message: string;
    traceId: string;
    userId?: string;
    log: FastifyBaseLogger;
}

export interface ExecutionResult {
    statusCode: number;
    body: unknown;
}

/**
 * Capture or reuse an immutable policy snapshot for audit trail.
 * Uses SHA-256 content-addressable storage: same policy hash → same snapshot id.
 * Must run within an existing PoolClient that already has app.current_org_id set.
 */
export async function captureOrReusePolicySnapshot(
    client: PoolClient,
    orgId: string,
    assistantId: string,
    versionId: string | null,
    policyJson: object,
    capturedBy: string | null
): Promise<string | null> {
    try {
        const policyHash = createHash('sha256')
            .update(JSON.stringify(policyJson))
            .digest('hex');

        // Reuse existing snapshot if same hash already exists for this org
        const existing = await client.query(
            `SELECT id FROM policy_snapshots
             WHERE org_id = $1 AND policy_hash = $2 LIMIT 1`,
            [orgId, policyHash]
        );
        if (existing.rows.length > 0) return existing.rows[0].id as string;

        // Create new immutable snapshot
        const result = await client.query(
            `INSERT INTO policy_snapshots
             (org_id, assistant_id, version_id, policy_hash, policy_json, captured_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [orgId, assistantId, versionId, policyHash, JSON.stringify(policyJson), capturedBy]
        );
        return result.rows[0].id as string;
    } catch (err) {
        // Non-fatal: snapshot failure must not block execution
        return null;
    }
}

export async function executeAssistant(params: ExecutionParams): Promise<ExecutionResult> {
    const { assistantId, orgId, message, traceId, userId, log } = params;
    const execStart = Date.now();
    const client = await pgPool.connect();

    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

        // ── 1. Fetch active assistant version + policy rules (Redis-cached, 60s TTL) ──
        // Cache format: { versionId, policyRules } — includes versionId for snapshot
        const cacheKey = `assistant:${assistantId}:policy`;
        let policyRules: any;
        let versionId: string | null = null;

        const cachedStr = await redisCache.get(cacheKey);
        if (cachedStr) {
            const cached = JSON.parse(cachedStr);
            policyRules = cached.policyRules;
            versionId = cached.versionId ?? null;
        } else {
            const versionRes = await client.query(`
                SELECT av.id as version_id, pv.rules_jsonb as policy_rules
                FROM assistant_versions av
                JOIN policy_versions pv ON av.policy_version_id = pv.id
                WHERE av.assistant_id = $1 AND av.status = 'published'
                ORDER BY av.version DESC LIMIT 1
            `, [assistantId]);

            if (versionRes.rows.length > 0) {
                policyRules = versionRes.rows[0].policy_rules;
                versionId = versionRes.rows[0].version_id as string;
                await redisCache.setex(cacheKey, 60, JSON.stringify({ versionId, policyRules }));
            } else {
                const assistantRes = await client.query(
                    'SELECT id FROM assistants WHERE id = $1 AND status = $2',
                    [assistantId, 'published']
                );
                if (assistantRes.rows.length === 0) {
                    return { statusCode: 404, body: { error: 'Assistente não encontrado.' } };
                }
                policyRules = { pii_filter: true, forbidden_topics: ['hack', 'bypass'] };
            }
        }

        // Capture immutable policy snapshot before governance evaluation
        const snapshotId = await captureOrReusePolicySnapshot(
            client, orgId, assistantId, versionId, policyRules, userId ?? null
        );

        // ── 2. Org query — single DB round-trip: telemetry consent + HITL timeout ──
        // Telemetria externa (Langfuse): somente com consentimento explícito do tenant.
        // LGPD Art. 7, I — o campo telemetry_consent é gerenciado pelo admin da org.
        // telemetry_pii_strip=TRUE: envia apenas métricas (sem prompt/completion).
        const orgRes = await client.query(
            'SELECT telemetry_consent, telemetry_pii_strip, hitl_timeout_hours FROM organizations WHERE id = $1',
            [orgId]
        );
        const { telemetry_consent, telemetry_pii_strip, hitl_timeout_hours } = orgRes.rows[0] || {
            telemetry_consent: false,
            telemetry_pii_strip: true,
            hitl_timeout_hours: 4,
        };
        // default 4h — configurable via organizations.hitl_timeout_hours
        const effectiveHitlTimeout: number = hitl_timeout_hours ?? 4;

        // ── 3. Governance evaluation (OPA + DLP + HITL keywords) ──────────────────
        const policyContext = { orgId, rules: policyRules };
        const policyCheck = await opaEngine.evaluate({ message, orgId }, policyContext);

        // ── 4. HITL: pause and queue for human review ─────────────────────────────
        if (policyCheck.action === 'PENDING_APPROVAL') {
            const sanitizedMessage = dlpEngine.sanitize(message).sanitizedText;
            const approvalRes = await client.query(
                `INSERT INTO pending_approvals (org_id, assistant_id, message, policy_reason, trace_id)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
                [orgId, assistantId, sanitizedMessage, policyCheck.reason, traceId]
            );
            const approvalId = approvalRes.rows[0].id;
            const hitlPayload = { reason: policyCheck.reason, input: sanitizedMessage, approvalId, traceId, snapshotId };
            const signature = IntegrityService.signPayload(hitlPayload, process.env.SIGNING_SECRET!);

            await auditQueue.add('persist-log', {
                org_id: orgId, assistant_id: assistantId,
                action: 'PENDING_APPROVAL' satisfies ActionType,
                metadata: hitlPayload, signature, traceId
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            await recordEvidence(client, {
                orgId, category: 'approval', eventType: 'APPROVAL_REQUESTED',
                actorId: userId ?? null, resourceType: 'assistant', resourceId: assistantId,
                metadata: { approvalId, traceId, reason: policyCheck.reason, snapshotId },
            });

            await notificationQueue.add('send-notification', {
                event: 'PENDING_APPROVAL', orgId, assistantId, approvalId,
                reason: policyCheck.reason || 'Ação de alto risco',
                traceId, expiresAt: new Date(Date.now() + effectiveHitlTimeout * 60 * 60 * 1000).toISOString(),
                timestamp: new Date().toISOString(),
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            return {
                statusCode: 202,
                body: {
                    status: 'PENDING_APPROVAL', approvalId, traceId,
                    message: 'Ação de alto risco detectada. Execução pausada e aguardando aprovação humana.',
                    reason: policyCheck.reason,
                },
            };
        }

        // ── 5. Policy violation: blocked ──────────────────────────────────────────
        if (!policyCheck.allowed) {
            recordRequest('blocked', Date.now() - execStart);
            const sanitizedMessage = policyCheck.sanitizedInput || dlpEngine.sanitize(message).sanitizedText;
            const violationPayload = { reason: policyCheck.reason, input: sanitizedMessage, traceId, snapshotId };
            const signature = IntegrityService.signPayload(violationPayload, process.env.SIGNING_SECRET!);

            await auditQueue.add('persist-log', {
                org_id: orgId, assistant_id: assistantId,
                action: 'POLICY_VIOLATION' satisfies ActionType,
                metadata: violationPayload, signature, traceId
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            await recordEvidence(client, {
                orgId, category: 'policy_enforcement', eventType: 'POLICY_VIOLATION',
                actorId: userId ?? null, resourceType: 'assistant', resourceId: assistantId,
                metadata: { traceId, reason: policyCheck.reason, snapshotId },
            });

            log.warn({ orgId, assistantId, reason: policyCheck.reason }, 'Policy Violation');
            return { statusCode: 403, body: { error: policyCheck.reason, traceId } };
        }

        // ── 6. DLP flag: use sanitized message downstream ─────────────────────────
        const safeMessage = policyCheck.sanitizedInput || message;
        if (policyCheck.action === 'FLAG') {
            log.info({
                orgId, assistantId,
                dlpDetections: policyCheck.dlpReport?.totalDetections,
                dlpTypes: policyCheck.dlpReport?.types,
            }, 'DLP: PII detected and masked before pipeline');
            if (policyCheck.dlpReport) {
                recordDlpDetection(policyCheck.dlpReport.totalDetections);
            }
        }

        // ── 7. FinOps quota enforcement (only reached if request is allowed) ──────
        const quota = await checkQuota(pgPool, orgId, assistantId);
        if (quota.exceeded) {
            return { statusCode: 429, body: { error: 'Limite da cota de uso mensal (Hard Cap) excedido.' } };
        }

        const quotaHeaders: Record<string, string> = {};
        if (quota.warning) {
            quotaHeaders['X-GovAI-Quota-Warning'] = 'Soft Cap exceeded';
        }

        // ── 8. RAG context retrieval (token-aware) ────────────────────────────────
        let ragContext = '';
        let ragMeta = { chunksUsed: 0, estimatedTokens: 0, truncated: false };
        try {
            const kbRes = await client.query(
                'SELECT id FROM knowledge_bases WHERE assistant_id = $1 LIMIT 1',
                [assistantId]
            );
            if (kbRes.rows.length > 0) {
                const { searchWithTokenLimit } = await import('../lib/rag');
                const aiModel = process.env.AI_MODEL || 'gemini/gemini-1.5-flash';
                const ragResult = await searchWithTokenLimit(pgPool, kbRes.rows[0].id, orgId, safeMessage, aiModel, 10);
                ragContext = ragResult.context;
                ragMeta = {
                    chunksUsed: ragResult.chunksUsed,
                    estimatedTokens: ragResult.estimatedTokens,
                    truncated: ragResult.truncated,
                };
                if (ragResult.chunksUsed > 0) {
                    log.info({
                        assistantId,
                        chunksUsed: ragResult.chunksUsed,
                        chunksAvailable: ragResult.chunksAvailable,
                        estimatedTokens: ragResult.estimatedTokens,
                        tokenBudget: ragResult.tokenBudget,
                        truncated: ragResult.truncated,
                    }, 'RAG context injected (token-aware)');
                }
            }
        } catch (ragError) {
            log.warn(ragError, 'RAG retrieval failed, proceeding without context');
        }

        // ── 9. LiteLLM proxy call ─────────────────────────────────────────────────
        const messages: { role: string; content: string }[] = [];
        if (ragContext) {
            messages.push({
                role: 'system',
                content: `Use the following proprietary knowledge base context to answer the user's question. If the context doesn't contain the answer, say you don't have enough information.\n\n---\n${ragContext}\n---`,
            });
        }
        messages.push({ role: 'user', content: safeMessage });

        let aiResponse: any;
        try {
            aiResponse = await axios.post(
                `${process.env.LITELLM_URL}/chat/completions`,
                { model: process.env.AI_MODEL || 'gemini/gemini-1.5-flash', messages },
                { headers: { Authorization: `Bearer ${process.env.LITELLM_KEY}` }, timeout: 30000 }
            );
        } catch (error: any) {
            log.error(error, 'Error communicating with LiteLLM');
            return {
                statusCode: 502,
                body: { error: 'Falha ao comunicar com o provedor de IA', details: error.message, traceId },
            };
        }

        // DLP-sanitize the full audit payload before signing (input + AI output)
        const rawLogContent = {
            input: safeMessage,
            output: aiResponse.data.choices[0],
            usage: aiResponse.data.usage,
            traceId,
            snapshotId,
            ...(policyCheck.dlpReport ? { dlp: policyCheck.dlpReport } : {}),
        };
        const { sanitized: logContent } = await dlpEngine.sanitizeObject(rawLogContent);
        const signature = IntegrityService.signPayload(logContent, process.env.SIGNING_SECRET!);

        await auditQueue.add('persist-log', {
            org_id: orgId, assistant_id: assistantId,
            action: 'EXECUTION_SUCCESS' satisfies ActionType,
            metadata: logContent, signature, traceId
        }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

        await recordEvidence(client, {
            orgId, category: 'execution', eventType: 'EXECUTION_SUCCESS',
            actorId: userId ?? null, resourceType: 'assistant', resourceId: assistantId,
            metadata: { traceId, snapshotId, tokens: aiResponse.data.usage },
        });

        const tokensPrompt = aiResponse.data.usage?.prompt_tokens || 0;
        const tokensCompletion = aiResponse.data.usage?.completion_tokens || 0;
        const aiModel = process.env.AI_MODEL || 'gemini-1.5-flash';
        const costUsd = (aiResponse.data.usage?.total_tokens || 0) * getCostPerToken(aiModel);
        const latencyMs = Date.now() - execStart;

        await recordTokenUsage(pgPool, orgId, assistantId, tokensPrompt, tokensCompletion, costUsd, traceId)
            .catch((e: Error) => log.error(e, 'Failed to update FinOps ledger'));

        if (telemetry_consent) {
            await telemetryQueue.add('export-metrics', {
                org_id: orgId,
                assistant_id: assistantId,
                traceId,
                tokens: aiResponse.data.usage,
                cost: costUsd,
                latency_ms: latencyMs,
                model: aiModel,
                // prompt e completion são omitidos se pii_strip estiver ativo
                prompt: telemetry_pii_strip ? null : safeMessage,
                completion: telemetry_pii_strip ? null : aiResponse.data.choices[0].message?.content,
                pii_stripped: telemetry_pii_strip,
            }, { removeOnComplete: true });
        }

        log.info({ orgId, assistantId, tokens: aiResponse.data.usage?.total_tokens }, 'Execution Success');
        recordRequest('success', latencyMs);
        // Per-assistant latency histogram (P95/P99 drill-down in Grafana)
        assistantLatencyHistogram.observe({ assistant_id: assistantId }, latencyMs);

        return {
            statusCode: 200,
            body: { ...aiResponse.data, _govai: { traceId, signature, snapshotId, ragMeta } },
        };

    } catch (error) {
        log.error(error, 'Unexpected error in execution service');
        return { statusCode: 500, body: { error: 'Erro interno do servidor' } };
    } finally {
        client.release();
    }
}
