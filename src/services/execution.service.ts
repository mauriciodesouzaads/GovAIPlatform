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
 *   8.5 MCP tool resolution (connector_version_grants per published version)
 *   9. LLM dispatch (with optional tools)
 *   9.5 MCP tool execution + second LLM call (if tool_calls returned)
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
    model?: string;
    log: FastifyBaseLogger;
}

export interface ExecutionResult {
    statusCode: number;
    body: unknown;
}

// Span type for Langfuse trace hierarchy
interface TelemetrySpan {
    name: string;
    type: 'span' | 'generation';
    startTime: string;
    endTime: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
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
    const { assistantId, orgId, message, traceId, userId, model: modelOverride, log } = params;
    const execStart = Date.now();
    // Single model resolution: request override > env default > built-in fallback
    const aiModel = modelOverride || process.env.AI_MODEL || 'govai-llm';
    const client = await pgPool.connect();

    // Spans collected throughout pipeline for Langfuse trace hierarchy
    const spans: TelemetrySpan[] = [];

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
        const govStart = Date.now();
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

        // Governance span (steps 3-6)
        spans.push({
            name: 'governance-pipeline',
            type: 'span',
            startTime: new Date(execStart).toISOString(),
            endTime: new Date().toISOString(),
            metadata: {
                decision: policyCheck.action,
                dlp_detections: policyCheck.dlpReport?.totalDetections || 0,
            },
        });

        // ── 7. FinOps quota enforcement (only reached if request is allowed) ──────
        const quota = await checkQuota(pgPool, orgId, assistantId);
        if (quota.exceeded) {
            const quotaPayload = {
                reason: 'Hard cap exceeded',
                traceId,
                snapshotId,
                orgId,
                assistantId,
            };
            const signature = IntegrityService.signPayload(
                quotaPayload,
                process.env.SIGNING_SECRET!
            );
            await auditQueue.add('persist-log', {
                org_id:       orgId,
                assistant_id: assistantId,
                action:       'QUOTA_EXCEEDED' satisfies ActionType,
                metadata:     quotaPayload,
                signature,
                traceId,
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
            return {
                statusCode: 429,
                body: { error: 'Limite da cota de uso mensal (Hard Cap) excedido.', traceId },
            };
        }

        const quotaHeaders: Record<string, string> = {};
        if (quota.warning) {
            quotaHeaders['X-GovAI-Quota-Warning'] = 'Soft Cap exceeded';
        }

        // ── 8. RAG context retrieval (token-aware) ────────────────────────────────
        let ragContext = '';
        let ragMeta = { chunksUsed: 0, estimatedTokens: 0, truncated: false };
        const ragStart = new Date();
        try {
            const kbRes = await client.query(
                'SELECT id FROM knowledge_bases WHERE assistant_id = $1 LIMIT 1',
                [assistantId]
            );
            if (kbRes.rows.length > 0) {
                const { searchWithTokenLimit } = await import('../lib/rag');
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
                    spans.push({
                        name: 'rag-retrieval',
                        type: 'span',
                        startTime: ragStart.toISOString(),
                        endTime: new Date().toISOString(),
                        metadata: { chunks_used: ragResult.chunksUsed, estimated_tokens: ragResult.estimatedTokens, truncated: ragResult.truncated },
                    });
                }
            }
        } catch (ragError) {
            log.warn(ragError, 'RAG retrieval failed, proceeding without context');
        }

        // ── 8.5 MCP Tool Resolution ───────────────────────────────────────────────
        // Fetch connector_version_grants for the active assistant version.
        // When no grants exist the mcpTools array is empty and tools are NOT passed
        // to LiteLLM — the pipeline is 100% identical to the pre-MCP behaviour.
        interface McpGrant {
            mcp_server_id: string;
            base_url: string;
            server_name: string;
            allowed_tools: string[];
        }
        let mcpTools: McpGrant[] = [];

        if (versionId) {
            try {
                const grantsResult = await client.query(`
                    SELECT cvg.mcp_server_id, cvg.allowed_tools_jsonb,
                           ms.base_url, ms.name as server_name
                    FROM connector_version_grants cvg
                    JOIN mcp_servers ms ON cvg.mcp_server_id = ms.id
                    WHERE cvg.assistant_version_id = $1
                      AND cvg.org_id = $2
                      AND ms.status = 'active'
                `, [versionId, orgId]);

                mcpTools = grantsResult.rows.map(r => ({
                    mcp_server_id: r.mcp_server_id,
                    base_url: r.base_url,
                    server_name: r.server_name,
                    allowed_tools: Array.isArray(r.allowed_tools_jsonb)
                        ? r.allowed_tools_jsonb
                        : JSON.parse(r.allowed_tools_jsonb || '[]'),
                }));
            } catch (err) {
                log.warn(err, 'Failed to fetch MCP grants, proceeding without tools');
            }
        }

        // Build tools array for LiteLLM (OpenAI function calling format)
        const tools = mcpTools.length > 0
            ? mcpTools.flatMap(grant =>
                grant.allowed_tools.map(toolName => ({
                    type: 'function' as const,
                    function: {
                        name: `${grant.server_name}__${toolName}`,
                        description: `Tool ${toolName} from MCP server ${grant.server_name}`,
                        parameters: { type: 'object', properties: {} },
                    },
                }))
            )
            : undefined;

        // ── 9. LiteLLM proxy call ─────────────────────────────────────────────────
        const messages: any[] = [];
        if (ragContext) {
            messages.push({
                role: 'system',
                content: `Use the following proprietary knowledge base context to answer the user's question. If the context doesn't contain the answer, say you don't have enough information.\n\n---\n${ragContext}\n---`,
            });
        }
        messages.push({ role: 'user', content: safeMessage });

        const llmStart = new Date();
        let aiResponse: any;
        try {
            aiResponse = await axios.post(
                `${process.env.LITELLM_URL}/chat/completions`,
                {
                    model: aiModel,
                    messages,
                    ...(tools ? { tools, tool_choice: 'auto' } : {}),
                },
                { headers: { Authorization: `Bearer ${process.env.LITELLM_KEY}` }, timeout: 30000 }
            );
        } catch (error: any) {
            log.error(error, 'Error communicating with LiteLLM');
            return {
                statusCode: 502,
                body: { error: 'Falha ao comunicar com o provedor de IA', details: error.message, traceId },
            };
        }

        // ── 9.5 MCP tool execution (if LLM returned tool_calls) ──────────────────
        const firstChoice = aiResponse.data.choices?.[0];
        if (firstChoice?.finish_reason === 'tool_calls' && firstChoice.message?.tool_calls?.length > 0) {
            const toolResults: Array<{ tool_call_id: string; content: string }> = [];

            for (const toolCall of firstChoice.message.tool_calls) {
                const funcName: string = toolCall.function?.name || '';
                const separatorIdx = funcName.indexOf('__');
                if (separatorIdx === -1) {
                    toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Invalid tool name format' }) });
                    continue;
                }
                const serverName = funcName.slice(0, separatorIdx);
                const toolName = funcName.slice(separatorIdx + 2);
                const args = (() => { try { return JSON.parse(toolCall.function?.arguments || '{}'); } catch { return {}; } })();

                const grant = mcpTools.find(g => g.server_name === serverName);
                if (!grant) {
                    log.warn({ serverName, toolName }, 'MCP server not found for tool call');
                    toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Server not found' }) });
                    continue;
                }

                // Zero-trust: verify tool is in the allowed list
                if (!grant.allowed_tools.includes(toolName)) {
                    log.warn({ serverName, toolName, allowed: grant.allowed_tools }, 'Tool not in allowed list');
                    await auditQueue.add('persist-log', {
                        org_id: orgId, assistant_id: assistantId,
                        action: 'TOOL_CALL_BLOCKED' satisfies ActionType,
                        metadata: { traceId, serverName, toolName, reason: 'not_in_allowed_tools' },
                        signature: IntegrityService.signPayload(
                            { traceId, serverName, toolName, reason: 'not_in_allowed_tools' },
                            process.env.SIGNING_SECRET!
                        ),
                        traceId,
                    }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
                    toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Tool not authorized' }) });
                    continue;
                }

                // Invoke the MCP server
                const toolStart = Date.now();
                const toolSpanStart = new Date().toISOString();
                try {
                    const mcpResponse = await axios.post(
                        `${grant.base_url}/tools/${toolName}`,
                        args,
                        { timeout: 15000, headers: { 'X-GovAI-Trace': traceId, 'X-GovAI-Org': orgId } }
                    );
                    const toolLatency = Date.now() - toolStart;

                    spans.push({
                        name: `tool-${serverName}-${toolName}`,
                        type: 'span',
                        startTime: toolSpanStart,
                        endTime: new Date().toISOString(),
                        metadata: {
                            server_name: serverName,
                            tool_name: toolName,
                            mcp_server_id: grant.mcp_server_id,
                            latency_ms: toolLatency,
                            status: 'success',
                        },
                    });

                    await auditQueue.add('persist-log', {
                        org_id: orgId, assistant_id: assistantId,
                        action: 'TOOL_CALL_SUCCESS' satisfies ActionType,
                        metadata: {
                            traceId, serverName, toolName,
                            mcp_server_id: grant.mcp_server_id,
                            latency_ms: toolLatency,
                            args_keys: Object.keys(args),
                            response_size: JSON.stringify(mcpResponse.data).length,
                        },
                        signature: IntegrityService.signPayload(
                            { traceId, serverName, toolName, mcp_server_id: grant.mcp_server_id },
                            process.env.SIGNING_SECRET!
                        ),
                        traceId,
                    }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

                    toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify(mcpResponse.data) });
                } catch (mcpError: any) {
                    const toolLatency = Date.now() - toolStart;

                    spans.push({
                        name: `tool-${serverName}-${toolName}`,
                        type: 'span',
                        startTime: toolSpanStart,
                        endTime: new Date().toISOString(),
                        metadata: {
                            server_name: serverName,
                            tool_name: toolName,
                            mcp_server_id: grant.mcp_server_id,
                            latency_ms: toolLatency,
                            status: 'failed',
                            error: mcpError.message,
                        },
                    });

                    await auditQueue.add('persist-log', {
                        org_id: orgId, assistant_id: assistantId,
                        action: 'TOOL_CALL_FAILED' satisfies ActionType,
                        metadata: {
                            traceId, serverName, toolName,
                            mcp_server_id: grant.mcp_server_id,
                            latency_ms: toolLatency,
                            error: mcpError.message,
                        },
                        signature: IntegrityService.signPayload(
                            { traceId, serverName, toolName, error: mcpError.message },
                            process.env.SIGNING_SECRET!
                        ),
                        traceId,
                    }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

                    toolResults.push({ tool_call_id: toolCall.id, content: JSON.stringify({ error: mcpError.message }) });
                }
            }

            // Second LLM call with tool results
            // Strip provider_specific_fields and non-standard LiteLLM fields (caller, index)
            // that Anthropic rejects in the follow-up message.
            const sanitizedToolCalls = (firstChoice.message.tool_calls ?? []).map((tc: any) => ({
                id: tc.id,
                type: tc.type,
                function: tc.function,
            }));
            messages.push({
                role: firstChoice.message.role,
                content: firstChoice.message.content ?? null,
                tool_calls: sanitizedToolCalls,
            });
            for (const result of toolResults) {
                messages.push({ role: 'tool', tool_call_id: result.tool_call_id, content: result.content });
            }

            const llm2Start = new Date();
            try {
                aiResponse = await axios.post(
                    `${process.env.LITELLM_URL}/chat/completions`,
                    { model: aiModel, messages, ...(tools ? { tools, tool_choice: 'auto' } : {}) },
                    { headers: { Authorization: `Bearer ${process.env.LITELLM_KEY}` }, timeout: 60000 }
                );
                spans.push({
                    name: 'llm-followup',
                    type: 'generation',
                    startTime: llm2Start.toISOString(),
                    endTime: new Date().toISOString(),
                    input: '[tool_results]',
                    output: telemetry_pii_strip ? '[PII_STRIPPED]' : aiResponse.data.choices?.[0]?.message?.content,
                    metadata: { model: aiModel, tokens: aiResponse.data.usage, is_followup: true },
                });
            } catch (error: any) {
                log.warn(error, 'LLM follow-up failed after tool calls — using first LLM response as fallback');
                // Graceful fallback: return first LLM response with tool error context
                // instead of a hard 502. The user still gets a useful answer.
                const firstContent = firstChoice.message?.content;
                if (firstContent) {
                    const toolNames = (firstChoice.message.tool_calls ?? [])
                        .map((tc: any) => tc.function?.name?.split('__')[1] ?? tc.function?.name)
                        .join(', ');
                    aiResponse.data.choices = [{
                        finish_reason: 'stop',
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: `${firstContent}\n\n*(Nota: a consulta às ferramentas externas (${toolNames}) não foi possível no momento. Resposta baseada no conhecimento interno.)*`,
                        },
                    }];
                    aiResponse.data.usage = aiResponse.data.usage || {};
                } else {
                    return { statusCode: 502, body: { error: 'Falha na segunda chamada ao LLM', traceId } };
                }
            }
        }

        // LLM generation span (first call)
        spans.push({
            name: 'llm-generation',
            type: 'generation',
            startTime: llmStart.toISOString(),
            endTime: new Date().toISOString(),
            input: telemetry_pii_strip ? '[PII_STRIPPED]' : safeMessage,
            output: telemetry_pii_strip ? '[PII_STRIPPED]' : aiResponse.data.choices?.[0]?.message?.content,
            metadata: { model: aiModel, tokens: aiResponse.data.usage, tools_count: tools?.length || 0 },
        });

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
        const costUsd = (aiResponse.data.usage?.total_tokens || 0) * getCostPerToken(aiModel);
        const latencyMs = Date.now() - execStart;

        await recordTokenUsage(pgPool, orgId, assistantId, tokensPrompt, tokensCompletion, costUsd, traceId)
            .catch((e: Error) => log.error(e, 'Failed to update FinOps ledger'));

        if (telemetry_consent) {
            await telemetryQueue.add('export-trace', {
                org_id: orgId,
                assistant_id: assistantId,
                traceId,
                traceName: `execution-${assistantId}`,
                spans,
                totalLatency: latencyMs,
                model: aiModel,
                pii_stripped: telemetry_pii_strip,
                // Legacy fields for backward compat
                tokens: aiResponse.data.usage,
                cost: costUsd,
                latency_ms: latencyMs,
                prompt: telemetry_pii_strip ? null : safeMessage,
                completion: telemetry_pii_strip ? null : aiResponse.data.choices[0]?.message?.content,
            }, { removeOnComplete: true });
        }

        log.info({ orgId, assistantId, tokens: aiResponse.data.usage?.total_tokens, mcp_tools: mcpTools.length }, 'Execution Success');
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
