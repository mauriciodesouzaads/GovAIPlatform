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
                    model_provider, model_name, model_version,
                    training_data_cutoff, training_data_description, fine_tuning_description,
                    known_limitations, known_biases, out_of_scope_uses, ethical_considerations,
                    business_owner_id, technical_owner_id, dpo_reviewer_id,
                    next_review_date, performance_metrics
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                ON CONFLICT (org_id, assistant_id) DO UPDATE SET
                    model_provider = EXCLUDED.model_provider,
                    model_name = EXCLUDED.model_name,
                    model_version = EXCLUDED.model_version,
                    training_data_cutoff = EXCLUDED.training_data_cutoff,
                    training_data_description = EXCLUDED.training_data_description,
                    fine_tuning_description = EXCLUDED.fine_tuning_description,
                    known_limitations = EXCLUDED.known_limitations,
                    known_biases = EXCLUDED.known_biases,
                    out_of_scope_uses = EXCLUDED.out_of_scope_uses,
                    ethical_considerations = EXCLUDED.ethical_considerations,
                    business_owner_id = EXCLUDED.business_owner_id,
                    technical_owner_id = EXCLUDED.technical_owner_id,
                    dpo_reviewer_id = EXCLUDED.dpo_reviewer_id,
                    next_review_date = EXCLUDED.next_review_date,
                    performance_metrics = EXCLUDED.performance_metrics,
                    updated_at = NOW()
                RETURNING *
            `, [
                orgId, assistantId,
                body.model_provider || body.provider || null,
                body.model_name || body.base_model || null,
                body.model_version || null,
                body.training_data_cutoff || null,
                body.training_data_description || null,
                body.fine_tuning_description || null,
                body.known_limitations || null,
                body.known_biases || body.potential_biases || null,
                body.out_of_scope_uses || body.out_of_scope_use || null,
                body.ethical_considerations || null,
                body.business_owner_id || null,
                body.technical_owner_id || null,
                body.dpo_reviewer_id || null,
                body.next_review_date || null,
                body.performance_metrics ? JSON.stringify(body.performance_metrics) : '{}',
            ]);

            return result.rows[0];
        } finally {
            client.release();
        }
    });
}
