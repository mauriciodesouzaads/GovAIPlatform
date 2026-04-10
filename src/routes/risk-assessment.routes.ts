import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { computeRiskScore } from '../lib/risk-questions';

export async function riskAssessmentRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;
    const auth = requireRole(['admin', 'dpo', 'auditor', 'compliance']);

    // GET /v1/admin/risk-assessments/:assistantId
    app.get('/v1/admin/risk-assessments/:assistantId', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { assistantId } = request.params as { assistantId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                SELECT ra.*, u.name as assessed_by_name
                FROM risk_assessments ra
                LEFT JOIN users u ON ra.assessed_by = u.id
                WHERE ra.assistant_id = $1 AND ra.org_id = $2
                ORDER BY ra.created_at DESC
                LIMIT 10
            `, [assistantId, orgId]);

            return result.rows;
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/risk-assessments — body: { assistant_id, version_id? }
    app.post('/v1/admin/risk-assessments', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const userId = (request.user as any)?.userId;
        const { assistant_id, version_id } = request.body as { assistant_id: string; version_id?: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(`
                INSERT INTO risk_assessments (org_id, assistant_id, version_id, status, answers, assessed_by)
                VALUES ($1, $2, $3, 'in_progress', '{}', $4)
                RETURNING *
            `, [orgId, assistant_id, version_id || null, userId]);
            return reply.status(201).send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/risk-assessments/:assistantId
    app.post('/v1/admin/risk-assessments/:assistantId', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const userId = (request.user as any)?.userId;
        const { assistantId } = request.params as { assistantId: string };
        const body = (request.body || {}) as { version_id?: string };
        const version_id = body.version_id;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                INSERT INTO risk_assessments (org_id, assistant_id, version_id, status, answers, assessed_by)
                VALUES ($1, $2, $3, 'in_progress', '{}', $4)
                RETURNING *
            `, [orgId, assistantId, version_id || null, userId]);

            return reply.status(201).send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // PUT /v1/admin/risk-assessments/:assessmentId/answers
    app.put('/v1/admin/risk-assessments/:assessmentId/answers', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { assessmentId } = request.params as { assessmentId: string };
        const { answers } = request.body as { answers: Record<string, any> };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                UPDATE risk_assessments
                SET answers = $1, updated_at = NOW()
                WHERE id = $2 AND org_id = $3 AND status = 'in_progress'
                RETURNING *
            `, [JSON.stringify(answers), assessmentId, orgId]);

            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Assessment not found or already completed' });
            }

            return result.rows[0];
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/risk-assessments/:assessmentId/complete
    app.post('/v1/admin/risk-assessments/:assessmentId/complete', { preHandler: auth, bodyLimit: 1 }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const userId = (request.user as any)?.userId;
        const { assessmentId } = request.params as { assessmentId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Fetch current assessment
            const fetched = await client.query(`
                SELECT * FROM risk_assessments
                WHERE id = $1 AND org_id = $2 AND status = 'in_progress'
            `, [assessmentId, orgId]);

            if (fetched.rows.length === 0) {
                return reply.status(404).send({ error: 'Assessment not found or already completed' });
            }

            const assessment = fetched.rows[0];
            const { totalScore, riskLevel, categoryScores, recommendations } = computeRiskScore(assessment.answers);

            const expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);

            const updated = await client.query(`
                UPDATE risk_assessments
                SET status = 'completed',
                    total_score = $1,
                    risk_level = $2,
                    category_scores = $3,
                    assessed_by = $4,
                    completed_at = NOW(),
                    expires_at = $5,
                    updated_at = NOW()
                WHERE id = $6 AND org_id = $7
                RETURNING *
            `, [
                totalScore, riskLevel, JSON.stringify(categoryScores),
                userId, expiresAt.toISOString(),
                assessmentId, orgId,
            ]);

            // Auto-update compliance assessments for risk_management controls if score >= 70
            if (totalScore >= 70) {
                await client.query(`
                    INSERT INTO compliance_assessments (org_id, control_id, status, evidence_notes, assessed_by, assessed_at)
                    SELECT $1, cc.id, 'compliant',
                        'Auto-assessed via Risk Assessment score ' || $2 || '/100',
                        $3, NOW()
                    FROM compliance_controls cc
                    WHERE cc.govai_feature = 'risk_scoring' AND cc.auto_assessment = 'auto_pass'
                    ON CONFLICT (org_id, control_id) DO UPDATE SET
                        status = 'compliant',
                        evidence_notes = EXCLUDED.evidence_notes,
                        assessed_by = EXCLUDED.assessed_by,
                        assessed_at = NOW(),
                        updated_at = NOW()
                `, [orgId, totalScore, userId]);
            }

            return {
                ...updated.rows[0],
                recommendations,
            };
        } finally {
            client.release();
        }
    });

    // GET /v1/admin/risk-assessments/:assessmentId/export
    app.get('/v1/admin/risk-assessments/:assessmentId/export', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { assessmentId } = request.params as { assessmentId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                SELECT ra.*, a.name as assistant_name, u.name as assessed_by_name,
                    o.name as org_name
                FROM risk_assessments ra
                JOIN assistants a ON ra.assistant_id = a.id
                LEFT JOIN users u ON ra.assessed_by = u.id
                JOIN organizations o ON ra.org_id = o.id
                WHERE ra.id = $1 AND ra.org_id = $2
            `, [assessmentId, orgId]);

            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Assessment not found' });
            }

            const assessment = result.rows[0];
            const { recommendations } = computeRiskScore(assessment.answers || {});

            return {
                ...assessment,
                recommendations,
                exported_at: new Date().toISOString(),
            };
        } finally {
            client.release();
        }
    });
}
