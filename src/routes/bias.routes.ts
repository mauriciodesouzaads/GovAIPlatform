/**
 * Bias Assessment Routes — FASE 13.1
 * ---------------------------------------------------------------------------
 * Endpoints for submitting and retrieving fairness assessments tied to an
 * assistant_version. Each assessment runs a deterministic scorer
 * (src/lib/bias-scoring.ts) against per-group inputs and records an
 * HMAC-signed evidence record.
 *
 * Routes:
 *   POST /v1/admin/bias-assessments                       — submit new
 *   GET  /v1/admin/bias-assessments/version/:versionId    — list by version
 *   GET  /v1/admin/bias-assessments/:id                   — fetch one
 *   GET  /v1/admin/bias-assessments/:id/evidence          — evidence record
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    computeBias,
    DEFAULT_THRESHOLDS,
    type GroupStats,
    type BiasThresholds,
} from '../lib/bias-scoring';
import { recordEvidence } from '../lib/evidence';
import { notificationQueue } from '../workers/notification.worker';

interface SubmitBody {
    assistant_version_id: string;
    test_dataset_name: string;
    test_dataset_size: number;
    protected_attributes: string[];
    group_breakdowns: Record<string, GroupStats>;
    thresholds?: Partial<BiasThresholds>;
    methodology_notes?: string;
}

export async function biasRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any },
) {
    const { pgPool, requireRole } = opts;
    const authRead = requireRole(['admin', 'dpo', 'auditor', 'compliance']);
    const authWrite = requireRole(['admin', 'dpo']);

    // ── POST /v1/admin/bias-assessments ────────────────────────────────────
    app.post('/v1/admin/bias-assessments', { preHandler: authWrite }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });

        const actor = request.user as { userId?: string; email?: string } | undefined;
        if (!actor?.userId) {
            return reply.status(401).send({ error: 'Actor user_id ausente no token' });
        }

        const body = request.body as Partial<SubmitBody> | undefined;
        if (!body
            || !body.assistant_version_id
            || !body.test_dataset_name
            || typeof body.test_dataset_size !== 'number'
            || !Array.isArray(body.protected_attributes)
            || !body.group_breakdowns
            || typeof body.group_breakdowns !== 'object') {
            return reply.status(400).send({
                error: 'assistant_version_id, test_dataset_name, test_dataset_size (int), protected_attributes (array), group_breakdowns (object) obrigatórios',
            });
        }

        const thresholds: BiasThresholds = {
            ...DEFAULT_THRESHOLDS,
            ...(body.thresholds ?? {}),
        };

        // Score first — fail fast on malformed inputs before touching the DB.
        let result: ReturnType<typeof computeBias>;
        try {
            result = computeBias(body.group_breakdowns, thresholds);
        } catch (err: any) {
            return reply.status(400).send({ error: err?.message || 'Invalid group_breakdowns' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            await client.query('BEGIN');

            // Verify the assistant_version belongs to this org (RLS already
            // enforces it, but a COUNT(*)=0 gives a clearer 404 than a FK
            // constraint error after INSERT).
            const verCheck = await client.query(
                `SELECT id FROM assistant_versions WHERE id = $1 AND org_id = $2`,
                [body.assistant_version_id, orgId],
            );
            if (verCheck.rowCount === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({
                    error: 'assistant_version não encontrado neste org',
                });
            }

            const insertRes = await client.query(
                `INSERT INTO bias_assessments (
                    org_id, assistant_version_id,
                    test_dataset_name, test_dataset_size, protected_attributes,
                    demographic_parity, equalized_odds, disparate_impact, statistical_parity,
                    thresholds, verdict, group_breakdowns, raw_results,
                    methodology_notes, performed_by
                ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::jsonb, $14, $15)
                RETURNING id, performed_at`,
                [
                    orgId,
                    body.assistant_version_id,
                    body.test_dataset_name,
                    body.test_dataset_size,
                    JSON.stringify(body.protected_attributes),
                    result.metrics.demographic_parity ?? null,
                    result.metrics.equalized_odds ?? null,
                    result.metrics.disparate_impact ?? null,
                    result.metrics.statistical_parity ?? null,
                    JSON.stringify(thresholds),
                    result.verdict,
                    JSON.stringify(result.group_breakdowns),
                    JSON.stringify({ violations: result.violations }),
                    body.methodology_notes ?? null,
                    actor.userId,
                ],
            );
            const assessmentId = insertRes.rows[0].id as string;

            // Record HMAC-signed evidence (uses the same RLS-bound client)
            const evidence = await recordEvidence(client, {
                orgId,
                category: 'bias_assessment',
                eventType: `BIAS_${result.verdict.toUpperCase()}`,
                actorId: actor.userId ?? null,
                actorEmail: actor.email ?? null,
                resourceType: 'assistant_version',
                resourceId: body.assistant_version_id,
                metadata: {
                    assessmentId,
                    verdict: result.verdict,
                    metrics: result.metrics,
                    violations: result.violations,
                    test_dataset_name: body.test_dataset_name,
                    test_dataset_size: body.test_dataset_size,
                    protected_attributes: body.protected_attributes,
                    thresholds,
                },
            });

            if (evidence?.id) {
                await client.query(
                    `UPDATE bias_assessments SET evidence_record_id = $1 WHERE id = $2`,
                    [evidence.id, assessmentId],
                );
            }

            // NOTE: we deliberately do NOT UPDATE assistant_versions here.
            // That table is immutable (prevent_version_mutation trigger),
            // so the "latest verdict" is derived on read via JOIN — see
            // the comment block in migration 081_bias_assessments.sql.
            await client.query('COMMIT');

            // Notification on fail (non-fatal).
            if (result.verdict === 'fail') {
                await notificationQueue.add('bias.fail', {
                    event: 'bias.fail',
                    orgId,
                    resourceType: 'assistant_version',
                    resourceId: body.assistant_version_id,
                    reason: `Bias assessment failed: ${result.violations.join('; ')}`,
                    timestamp: new Date().toISOString(),
                    metadata: {
                        assessmentId,
                        verdict: result.verdict,
                        metrics: result.metrics,
                        violations: result.violations,
                    },
                }).catch(() => { /* non-fatal */ });
            }

            return reply.status(201).send({
                id: assessmentId,
                assistant_version_id: body.assistant_version_id,
                verdict: result.verdict,
                metrics: result.metrics,
                violations: result.violations,
                thresholds,
                group_breakdowns: result.group_breakdowns,
                evidence_record_id: evidence?.id ?? null,
                performed_at: insertRes.rows[0].performed_at,
            });
        } catch (err: any) {
            await client.query('ROLLBACK').catch(() => {});
            // Uniqueness violation → 409 so the UI can show a helpful message.
            if (err?.code === '23505') {
                return reply.status(409).send({
                    error: 'Já existe avaliação com esse test_dataset_name para essa versão',
                });
            }
            app.log.error({ err }, 'bias_assessment_submit_failed');
            return reply.status(500).send({ error: 'Erro ao registrar avaliação de bias' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/bias-assessments/version/:versionId ──────────────────
    app.get('/v1/admin/bias-assessments/version/:versionId', { preHandler: authRead }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { versionId } = request.params as { versionId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `SELECT ba.id, ba.assistant_version_id, ba.test_dataset_name, ba.test_dataset_size,
                        ba.protected_attributes, ba.demographic_parity, ba.equalized_odds,
                        ba.disparate_impact, ba.statistical_parity, ba.thresholds, ba.verdict,
                        ba.group_breakdowns, ba.raw_results, ba.methodology_notes,
                        ba.performed_at, ba.evidence_record_id,
                        u.email AS performed_by_email, u.name AS performed_by_name
                   FROM bias_assessments ba
              LEFT JOIN users u ON u.id = ba.performed_by
                  WHERE ba.org_id = $1 AND ba.assistant_version_id = $2
               ORDER BY ba.performed_at DESC`,
                [orgId, versionId],
            );
            return reply.send({
                assistant_version_id: versionId,
                assessments: res.rows,
                total: res.rowCount,
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/bias-assessments/:id ─────────────────────────────────
    app.get('/v1/admin/bias-assessments/:id', { preHandler: authRead }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `SELECT ba.*, u.email AS performed_by_email, u.name AS performed_by_name
                   FROM bias_assessments ba
              LEFT JOIN users u ON u.id = ba.performed_by
                  WHERE ba.org_id = $1 AND ba.id = $2`,
                [orgId, id],
            );
            if (res.rowCount === 0) {
                return reply.status(404).send({ error: 'Avaliação não encontrada' });
            }
            return reply.send(res.rows[0]);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/bias-assessments/:id/evidence ────────────────────────
    app.get('/v1/admin/bias-assessments/:id/evidence', { preHandler: authRead }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `SELECT er.id, er.category, er.event_type, er.actor_id, er.actor_email,
                        er.resource_type, er.resource_id, er.metadata, er.integrity_hash,
                        er.created_at
                   FROM evidence_records er
                   JOIN bias_assessments ba ON ba.evidence_record_id = er.id
                  WHERE ba.org_id = $1 AND ba.id = $2`,
                [orgId, id],
            );
            if (res.rowCount === 0) {
                return reply.status(404).send({ error: 'Evidence record não encontrado' });
            }
            return reply.send(res.rows[0]);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
}
