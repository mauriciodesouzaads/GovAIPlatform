import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import { auditQueue } from '../workers/audit.worker';
import axios from 'axios';
import crypto from 'crypto';
import { checkQuota, recordTokenUsage, getCostPerToken } from '../lib/finops';
import { telemetryQueue } from '../workers/telemetry.worker';
import { ApprovalActionSchema, zodErrors } from '../lib/schemas';
import { recordEvidence } from '../lib/evidence';

export async function approvalsRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any; requireRole: any }) {
    const { pgPool, requireAdminAuth, requireRole } = opts;

    app.get('/v1/admin/approvals', { preHandler: requireRole(['sre', 'admin', 'dpo', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { status = 'pending' } = request.query as { status?: string };
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            const res = await client.query(
                `SELECT pa.id, pa.assistant_id, a.name as assistant_name, pa.message, pa.policy_reason, 
                    pa.trace_id, pa.status, pa.reviewer_email, pa.review_note, pa.reviewed_at, pa.created_at
             FROM pending_approvals pa
             LEFT JOIN assistants a ON a.id = pa.assistant_id
             WHERE pa.status = $1
             ORDER BY pa.created_at DESC`,
                [status]
            );
            const rows = res.rows.map(row => {
                let risk_level = 'low';
                let justification = row.policy_reason || 'Interceptação Manual';

                if (justification.toLowerCase().includes('pix') || justification.toLowerCase().includes('cpf') || justification.toLowerCase().includes('senha')) {
                    risk_level = 'high';
                } else if (justification.toLowerCase().includes('financeiro') || justification.toLowerCase().includes('confidencial') || justification.toLowerCase().includes('injection')) {
                    risk_level = 'high';
                } else if (justification.toLowerCase().includes('email') || justification.toLowerCase().includes('telefone')) {
                    risk_level = 'medium';
                }

                return {
                    ...row,
                    risk_level,
                    justification
                };
            });

            return reply.send(rows);
        } catch (error) {
            app.log.error(error, "Error fetching approvals");
            reply.status(500).send({ error: "Erro ao buscar aprovações" });
        } finally {
            client.release();
        }
    });

    // Approve a pending request (executes the AI call)
    app.post('/v1/admin/approvals/:approvalId/approve', { preHandler: requireRole(['sre', 'admin']) }, async (request, reply) => {
        const approveParsed = ApprovalActionSchema.safeParse(request.body);
        if (!approveParsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(approveParsed.error) });
        }

        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { approvalId } = request.params as { approvalId: string };
        const user = request.user as { email?: string };
        const { reviewNote } = approveParsed.data;

        const client = await pgPool.connect();
        try {
            // C2-residual FIX: Explicit transaction — if LiteLLM fails, we ROLLBACK the approval
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            // C2 FIX: Atomic UPDATE with TTL check (A2: expires_at > NOW())
            // GA-010 FIX 1: persist review_note in approve (was missing, only reject had it)
            const approvalRes = await client.query(
                `UPDATE pending_approvals
             SET status = 'approved', reviewer_email = $1, review_note = $2, reviewed_at = NOW()
             WHERE id = $3 AND status = 'pending' AND expires_at > NOW()
             RETURNING *`,
                [user?.email || 'admin', reviewNote, approvalId]
            );
            if (approvalRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return reply.status(409).send({
                    error: 'Conflito: esta aprovação já foi processada por outro administrador ou expirou.',
                    approvalId
                });
            }

            const approval = approvalRes.rows[0];

            // 4. Execute the original AI call (now approved)
            // Defense-in-depth: re-sanitize approval.message before RAG and LLM.
            const safeApprovalMessage = dlpEngine.sanitize(approval.message).sanitizedText;

            let ragContext = '';
            try {
                const kbRes = await client.query('SELECT id FROM knowledge_bases WHERE assistant_id = $1 LIMIT 1', [approval.assistant_id]);
                if (kbRes.rows.length > 0) {
                    const { searchWithTokenLimit } = await import('../lib/rag');
                    const aiModel = process.env.AI_MODEL || 'gemini/gemini-1.5-flash';
                    const ragResult = await searchWithTokenLimit(pgPool, kbRes.rows[0].id, orgId, safeApprovalMessage, aiModel, 10);
                    if (ragResult.chunksUsed > 0) ragContext = ragResult.context;
                }
            } catch { /* RAG optional */ }

            const quota = await checkQuota(pgPool, orgId, approval.assistant_id);
            if (quota.exceeded) {
                await client.query('ROLLBACK');
                return reply.status(429).send({ error: "Limite da cota de uso mensal (Hard Cap) excedido." });
            }

            const messages: { role: string; content: string }[] = [];
            if (ragContext) {
                messages.push({ role: 'system', content: `Use the following proprietary knowledge base context to answer the user's question.\n\n---\n${ragContext}\n---` });
            }
            messages.push({ role: 'user', content: safeApprovalMessage });

            let aiResponse;
            const execStart = Date.now();
            try {
                aiResponse = await axios.post(`${process.env.LITELLM_URL}/chat/completions`, {
                    model: process.env.AI_MODEL || 'gemini/gemini-1.5-flash',
                    messages
                }, {
                    headers: { 'Authorization': `Bearer ${process.env.LITELLM_KEY}` },
                    timeout: 30000
                });
            } catch (error: any) {
                // C2-residual FIX: Rollback approval if AI execution fails
                await client.query('ROLLBACK');
                app.log.error({ approvalId, error: error.message }, 'HITL: AI execution failed, rolling back approval');
                return reply.status(502).send({ error: 'Falha ao executar IA após aprovação — aprovação revertida', details: error.message });
            }

            // Prepare audit payloads (pure computation — no side effects yet)
            const approvalPayload = { approvalId, action: 'approved', reviewer: user?.email, originalMessage: approval.message, traceId: approval.trace_id };
            const approvalSig = IntegrityService.signPayload(approvalPayload, process.env.SIGNING_SECRET!);

            const { sanitized: logContent } = await dlpEngine.sanitizeObject({
                input: approval.message,
                output: aiResponse.data.choices[0],
                usage: aiResponse.data.usage,
                traceId: approval.trace_id,
                approvedBy: user?.email,
                approvalId,
            });
            const execSig = IntegrityService.signPayload(logContent, process.env.SIGNING_SECRET!);

            // GA-010 FIX 3: Read telemetry consent inside transaction (client still open) — used after COMMIT
            const orgConsent = await client.query('SELECT telemetry_consent FROM organizations WHERE id = $1', [orgId]);
            const telemetryEnabled = orgConsent.rows[0]?.telemetry_consent ?? false;

            // GA-010 FIX 2: COMMIT before side effects (queue/external calls must not run inside PG transaction)
            await client.query('COMMIT');
            app.log.info({ orgId, approvalId, reviewer: user?.email }, 'HITL: Execution approved and completed');

            // Evidence record (non-fatal; session-level set_config persists after COMMIT)
            await recordEvidence(client, {
                orgId, category: 'approval', eventType: 'APPROVAL_GRANTED',
                actorId: null, actorEmail: user?.email ?? null,
                resourceType: 'pending_approval', resourceId: approvalId,
                metadata: { approvalId, traceId: approval.trace_id, reviewer: user?.email, reviewNote },
            });

            // Side effects AFTER COMMIT
            // 3. Audit log for approval grant
            await auditQueue.add('persist-log', {
                org_id: orgId,
                assistant_id: approval.assistant_id,
                action: 'APPROVAL_GRANTED' satisfies ActionType,
                metadata: approvalPayload,
                signature: approvalSig,
                traceId: approval.trace_id
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            // 5. Audit log for execution
            await auditQueue.add('persist-log', {
                org_id: orgId,
                assistant_id: approval.assistant_id,
                action: 'EXECUTION_SUCCESS' satisfies ActionType,
                metadata: logContent,
                signature: execSig,
                traceId: approval.trace_id
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            // 6. FinOps
            const tokensPrompt = aiResponse.data.usage?.prompt_tokens || 0;
            const tokensCompletion = aiResponse.data.usage?.completion_tokens || 0;
            const aiModel = process.env.AI_MODEL || "gemini-1.5-flash";
            const costUsd = (aiResponse.data.usage?.total_tokens || 0) * getCostPerToken(aiModel);
            const latencyMs = Date.now() - execStart;

            await recordTokenUsage(pgPool, orgId, approval.assistant_id, tokensPrompt, tokensCompletion, costUsd, approval.trace_id)
                .catch((e: Error) => app.log.error(e, 'Failed to update FinOps ledger'));

            // GA-010 FIX 3: Only enqueue telemetry if org has consented (consent read before COMMIT)
            if (telemetryEnabled) {
                await telemetryQueue.add('export-metrics', {
                    org_id: orgId,
                    assistant_id: approval.assistant_id,
                    traceId: approval.trace_id,
                    tokens: aiResponse.data.usage,
                    cost: costUsd,
                    latency_ms: latencyMs,
                    model: aiModel
                }, { removeOnComplete: true });
            }

            return reply.send({
                status: 'APPROVED_AND_EXECUTED',
                approvalId,
                response: aiResponse.data,
                _govai: { traceId: approval.trace_id, signature: execSig }
            });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => { });
            app.log.error(error, "Error processing approval");
            reply.status(500).send({ error: "Erro ao processar aprovação" });
        } finally {
            client.release();
        }
    });

    // Reject a pending request
    app.post('/v1/admin/approvals/:approvalId/reject', { preHandler: requireRole(['sre', 'admin']) }, async (request, reply) => {
        const rejectParsed = ApprovalActionSchema.safeParse(request.body);
        if (!rejectParsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(rejectParsed.error) });
        }
        const { reviewNote: note } = rejectParsed.data;

        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { approvalId } = request.params as { approvalId: string };
        const user = request.user as { email?: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            // C2 FIX: Atomic UPDATE RETURNING with TTL check
            const approvalRes = await client.query(
                `UPDATE pending_approvals 
             SET status = 'rejected', reviewer_email = $1, review_note = $2, reviewed_at = NOW() 
             WHERE id = $3 AND status = 'pending' AND expires_at > NOW()
             RETURNING *`,
                [user?.email || 'admin', note, approvalId]
            );
            if (approvalRes.rows.length === 0) {
                return reply.status(409).send({
                    error: 'Conflito: esta aprovação já foi processada por outro administrador ou expirou.',
                    approvalId
                });
            }

            const approval = approvalRes.rows[0];

            const rejectPayload = { approvalId, action: 'rejected', reviewer: user?.email, note, originalMessage: approval.message, traceId: approval.trace_id };
            const rejectSig = IntegrityService.signPayload(rejectPayload, process.env.SIGNING_SECRET!);
            await auditQueue.add('persist-log', {
                org_id: orgId,
                assistant_id: approval.assistant_id,
                action: 'APPROVAL_REJECTED' satisfies ActionType,
                metadata: rejectPayload,
                signature: rejectSig,
                traceId: approval.trace_id
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            await recordEvidence(client, {
                orgId, category: 'approval', eventType: 'APPROVAL_REJECTED',
                actorId: null, actorEmail: user?.email ?? null,
                resourceType: 'pending_approval', resourceId: approvalId,
                metadata: { approvalId, traceId: approval.trace_id, reviewer: user?.email, note },
            });

            app.log.info({ orgId, approvalId, reviewer: user?.email }, 'HITL: Execution rejected');

            return reply.send({ status: 'REJECTED', approvalId, message: 'Solicitação rejeitada pelo administrador.' });
        } catch (error) {
            app.log.error(error, "Error rejecting approval");
            reply.status(500).send({ error: "Erro ao rejeitar aprovação" });
        } finally {
            client.release();
        }
    });

    // --- COMPLIANCE REPORTING ---

    // Compliance Report (JSON preview or PDF download)

}
