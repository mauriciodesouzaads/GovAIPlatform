import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

export async function modelCardRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;
    const auth = requireRole(['admin', 'dpo', 'auditor', 'compliance']);
    const authWrite = requireRole(['admin', 'dpo']);

    // GET /v1/admin/assistants/:assistantId/model-card
    app.get('/v1/admin/assistants/:assistantId/model-card', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { assistantId } = request.params as { assistantId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                SELECT mc.*,
                    u1.name as business_owner_name, u1.email as business_owner_email,
                    u2.name as technical_owner_name, u2.email as technical_owner_email,
                    u3.name as dpo_reviewer_name, u3.email as dpo_reviewer_email
                FROM model_cards mc
                LEFT JOIN users u1 ON mc.business_owner_id = u1.id
                LEFT JOIN users u2 ON mc.technical_owner_id = u2.id
                LEFT JOIN users u3 ON mc.dpo_reviewer_id = u3.id
                WHERE mc.assistant_id = $1 AND mc.org_id = $2
            `, [assistantId, orgId]);

            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Model card not found' });
            }

            return result.rows[0];
        } finally {
            client.release();
        }
    });

    // PUT /v1/admin/assistants/:assistantId/model-card
    app.put('/v1/admin/assistants/:assistantId/model-card', { preHandler: authWrite }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { assistantId } = request.params as { assistantId: string };
        const body = request.body as Record<string, any>;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                INSERT INTO model_cards (
                    org_id, assistant_id,
                    provider, base_model, training_data_cutoff, fine_tuned,
                    intended_use, out_of_scope_use,
                    known_limitations, potential_biases, evaluation_datasets,
                    business_owner_id, technical_owner_id, dpo_reviewer_id,
                    review_frequency_days, next_review_date,
                    eu_ai_act_risk_level, lgpd_applies, data_residency,
                    extra_metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                ON CONFLICT (org_id, assistant_id) DO UPDATE SET
                    provider = EXCLUDED.provider,
                    base_model = EXCLUDED.base_model,
                    training_data_cutoff = EXCLUDED.training_data_cutoff,
                    fine_tuned = EXCLUDED.fine_tuned,
                    intended_use = EXCLUDED.intended_use,
                    out_of_scope_use = EXCLUDED.out_of_scope_use,
                    known_limitations = EXCLUDED.known_limitations,
                    potential_biases = EXCLUDED.potential_biases,
                    evaluation_datasets = EXCLUDED.evaluation_datasets,
                    business_owner_id = EXCLUDED.business_owner_id,
                    technical_owner_id = EXCLUDED.technical_owner_id,
                    dpo_reviewer_id = EXCLUDED.dpo_reviewer_id,
                    review_frequency_days = EXCLUDED.review_frequency_days,
                    next_review_date = EXCLUDED.next_review_date,
                    eu_ai_act_risk_level = EXCLUDED.eu_ai_act_risk_level,
                    lgpd_applies = EXCLUDED.lgpd_applies,
                    data_residency = EXCLUDED.data_residency,
                    extra_metadata = EXCLUDED.extra_metadata,
                    updated_at = NOW()
                RETURNING *
            `, [
                orgId, assistantId,
                body.provider || null,
                body.base_model || null,
                body.training_data_cutoff || null,
                body.fine_tuned ?? false,
                body.intended_use || null,
                body.out_of_scope_use || null,
                body.known_limitations || null,
                body.potential_biases || null,
                body.evaluation_datasets || null,
                body.business_owner_id || null,
                body.technical_owner_id || null,
                body.dpo_reviewer_id || null,
                body.review_frequency_days || 180,
                body.next_review_date || null,
                body.eu_ai_act_risk_level || 'limited',
                body.lgpd_applies ?? false,
                body.data_residency || 'brazil',
                body.extra_metadata ? JSON.stringify(body.extra_metadata) : null,
            ]);

            return result.rows[0];
        } finally {
            client.release();
        }
    });
}
