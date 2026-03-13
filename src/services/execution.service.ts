/**
 * Execution Service — Core AI governance pipeline for /v1/execute/:assistantId.
 *
 * Extracted from server.ts to improve testability, readability, and separation of concerns.
 * The route handler in server.ts is now a thin adapter that delegates here.
 */

import { FastifyBaseLogger } from 'fastify';
import axios from 'axios';
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

export interface ExecutionParams {
    assistantId: string;
    orgId: string;
    message: string;
    traceId: string;
    log: FastifyBaseLogger;
}

export interface ExecutionResult {
    statusCode: number;
    body: unknown;
}

export async function executeAssistant(params: ExecutionParams): Promise<ExecutionResult> {
    const { assistantId, orgId, message, traceId, log } = params;
    const execStart = Date.now();
    const client = await pgPool.connect();

    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

        // FinOps quota enforcement
        const quota = await checkQuota(pgPool, orgId, assistantId);
        if (quota.exceeded) {
            return { statusCode: 429, body: { error: 'Limite da cota de uso mensal (Hard Cap) excedido.' } };
        }

        const quotaHeaders: Record<string, string> = {};
        if (quota.warning) {
            quotaHeaders['X-GovAI-Quota-Warning'] = 'Soft Cap exceeded';
        }

        // Fetch active assistant version + policy rules (Redis-cached, 60s TTL)
        const cacheKey = `assistant:${assistantId}:rules`;
        let policyRulesStr = await redisCache.get(cacheKey);
        let policyRules: any;

        if (policyRulesStr) {
            policyRules = JSON.parse(policyRulesStr);
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
                await redisCache.setex(cacheKey, 60, JSON.stringify(policyRules));
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

        // Governance evaluation (OPA + DLP + HITL keywords)
        const policyContext = { orgId, rules: policyRules };
        const policyCheck = await opaEngine.evaluate({ message, orgId }, policyContext);

        // HITL: pause and queue for human review
        if (policyCheck.action === 'PENDING_APPROVAL') {
            const sanitizedMessage = dlpEngine.sanitize(message).sanitizedText;
            const approvalRes = await client.query(
                `INSERT INTO pending_approvals (org_id, assistant_id, message, policy_reason, trace_id)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
                [orgId, assistantId, sanitizedMessage, policyCheck.reason, traceId]
            );
            const approvalId = approvalRes.rows[0].id;
            const hitlPayload = { reason: policyCheck.reason, input: sanitizedMessage, approvalId, traceId };
            const signature = IntegrityService.signPayload(hitlPayload, process.env.SIGNING_SECRET!);

            await auditQueue.add('persist-log', {
                org_id: orgId, assistant_id: assistantId,
                action: 'PENDING_APPROVAL' satisfies ActionType,
                metadata: hitlPayload, signature, traceId
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            await notificationQueue.add('send-notification', {
                event: 'PENDING_APPROVAL', orgId, assistantId, approvalId,
                reason: policyCheck.reason || 'Ação de alto risco',
                traceId, expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
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

        // Policy violation: blocked
        if (!policyCheck.allowed) {
            recordRequest('blocked', Date.now() - execStart);
            const sanitizedMessage = policyCheck.sanitizedInput || dlpEngine.sanitize(message).sanitizedText;
            const violationPayload = { reason: policyCheck.reason, input: sanitizedMessage, traceId };
            const signature = IntegrityService.signPayload(violationPayload, process.env.SIGNING_SECRET!);

            await auditQueue.add('persist-log', {
                org_id: orgId, assistant_id: assistantId,
                action: 'POLICY_VIOLATION' satisfies ActionType,
                metadata: violationPayload, signature, traceId
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            log.warn({ orgId, assistantId, reason: policyCheck.reason }, 'Policy Violation');
            return { statusCode: 403, body: { error: policyCheck.reason, traceId } };
        }

        // DLP flag: use sanitized message downstream
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

        // RAG context retrieval (token-aware)
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
                const ragResult = await searchWithTokenLimit(pgPool, kbRes.rows[0].id, safeMessage, aiModel, 10);
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

        // LiteLLM proxy call
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
            ...(policyCheck.dlpReport ? { dlp: policyCheck.dlpReport } : {}),
        };
        const { sanitized: logContent } = await dlpEngine.sanitizeObject(rawLogContent);
        const signature = IntegrityService.signPayload(logContent, process.env.SIGNING_SECRET!);

        await auditQueue.add('persist-log', {
            org_id: orgId, assistant_id: assistantId,
            action: 'EXECUTION_SUCCESS' satisfies ActionType,
            metadata: logContent, signature, traceId
        }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

        const tokensPrompt = aiResponse.data.usage?.prompt_tokens || 0;
        const tokensCompletion = aiResponse.data.usage?.completion_tokens || 0;
        const aiModel = process.env.AI_MODEL || 'gemini-1.5-flash';
        const costUsd = (aiResponse.data.usage?.total_tokens || 0) * getCostPerToken(aiModel);
        const latencyMs = Date.now() - execStart;

        await recordTokenUsage(pgPool, orgId, assistantId, tokensPrompt, tokensCompletion, costUsd, traceId)
            .catch((e: Error) => log.error(e, 'Failed to update FinOps ledger'));

        // Telemetria externa (Langfuse): somente com consentimento explícito do tenant.
        // LGPD Art. 7, I — o campo telemetry_consent é gerenciado pelo admin da org.
        // telemetry_pii_strip=TRUE: envia apenas métricas (sem prompt/completion).
        const telemetryRes = await client.query(
            'SELECT telemetry_consent, telemetry_pii_strip FROM organizations WHERE id = $1',
            [orgId]
        );
        const { telemetry_consent, telemetry_pii_strip } = telemetryRes.rows[0] || {
            telemetry_consent: false,
            telemetry_pii_strip: true,
        };

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
            body: { ...aiResponse.data, _govai: { traceId, signature, ragMeta } },
        };

    } catch (error) {
        log.error(error, 'Unexpected error in execution service');
        return { statusCode: 500, body: { error: 'Erro interno do servidor' } };
    } finally {
        client.release();
    }
}
