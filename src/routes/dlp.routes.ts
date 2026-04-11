import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { redisCache } from '../lib/redis';
import { dlpEngine } from '../lib/dlp-engine';

// Cache TTL in seconds (5 minutes)
const DLP_CACHE_TTL = 300;

function dlpCacheKey(orgId: string) {
    return `dlp_rules:${orgId}`;
}

async function invalidateCache(orgId: string) {
    try {
        await redisCache.del(dlpCacheKey(orgId));
    } catch {
        // Redis unavailable — non-fatal
    }
}

export async function dlpRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;
    const auth     = requireRole(['admin', 'dpo']);
    const authAdmin = requireRole(['admin']);

    // ── GET /v1/admin/dlp/rules ───────────────────────────────────────────────
    // Returns all DLP rules for the org (active and inactive).
    app.get('/v1/admin/dlp/rules', { preHandler: auth }, async (request, reply) => {
        const orgId  = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT id, name, detector_type, pattern, pattern_config, action,
                        applies_to, is_active, is_system, created_at, updated_at
                 FROM dlp_rules
                 WHERE org_id = $1
                 ORDER BY is_system DESC, created_at ASC`,
                [orgId]
            );
            return result.rows;
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/dlp/rules ──────────────────────────────────────────────
    // Creates a new custom DLP rule. is_system is always false for API-created rules.
    app.post('/v1/admin/dlp/rules', { preHandler: authAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const body  = request.body as {
            name: string;
            detector_type: 'builtin' | 'regex' | 'keyword_list';
            pattern?: string;
            pattern_config?: Record<string, unknown>;
            action: 'mask' | 'block' | 'alert';
            applies_to?: string[];
            is_active?: boolean;
        };

        if (!body.name || !body.detector_type || !body.action) {
            return reply.status(400).send({ error: 'name, detector_type e action são obrigatórios.' });
        }
        if (body.detector_type === 'regex' && !body.pattern) {
            return reply.status(400).send({ error: 'pattern é obrigatório para detector_type regex.' });
        }
        if (body.detector_type === 'keyword_list') {
            const kws = (body.pattern_config as any)?.keywords;
            if (!Array.isArray(kws) || kws.length === 0) {
                return reply.status(400).send({ error: 'pattern_config.keywords é obrigatório para detector_type keyword_list.' });
            }
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `INSERT INTO dlp_rules
                    (org_id, name, detector_type, pattern, pattern_config, action, applies_to, is_active, is_system)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
                 RETURNING id, name, detector_type, pattern, pattern_config, action,
                           applies_to, is_active, is_system, created_at, updated_at`,
                [
                    orgId,
                    body.name,
                    body.detector_type,
                    body.pattern ?? null,
                    JSON.stringify(body.pattern_config ?? {}),
                    body.action,
                    JSON.stringify(body.applies_to ?? []),
                    body.is_active ?? true,
                ]
            );
            await invalidateCache(orgId);
            return reply.status(201).send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/dlp/rules/:id ───────────────────────────────────────────
    // Updates a rule. System rules may only change: action, is_active, applies_to.
    app.put('/v1/admin/dlp/rules/:id', { preHandler: authAdmin }, async (request, reply) => {
        const orgId  = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const body   = request.body as {
            name?: string;
            detector_type?: string;
            pattern?: string;
            pattern_config?: Record<string, unknown>;
            action?: 'mask' | 'block' | 'alert';
            applies_to?: string[];
            is_active?: boolean;
        };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Fetch existing rule
            const existing = await client.query(
                'SELECT * FROM dlp_rules WHERE id = $1 AND org_id = $2',
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Regra não encontrada.' });
            }
            const rule = existing.rows[0];

            // For system rules: only allow action, is_active, applies_to
            let query: string;
            let params: unknown[];
            if (rule.is_system) {
                query = `UPDATE dlp_rules
                         SET action     = COALESCE($3, action),
                             is_active  = COALESCE($4, is_active),
                             applies_to = COALESCE($5, applies_to)
                         WHERE id = $1 AND org_id = $2
                         RETURNING id, name, detector_type, pattern, pattern_config, action,
                                   applies_to, is_active, is_system, created_at, updated_at`;
                params = [id, orgId, body.action ?? null, body.is_active ?? null,
                          body.applies_to ? JSON.stringify(body.applies_to) : null];
            } else {
                query = `UPDATE dlp_rules
                         SET name           = COALESCE($3, name),
                             detector_type  = COALESCE($4, detector_type),
                             pattern        = COALESCE($5, pattern),
                             pattern_config = COALESCE($6, pattern_config),
                             action         = COALESCE($7, action),
                             applies_to     = COALESCE($8, applies_to),
                             is_active      = COALESCE($9, is_active)
                         WHERE id = $1 AND org_id = $2
                         RETURNING id, name, detector_type, pattern, pattern_config, action,
                                   applies_to, is_active, is_system, created_at, updated_at`;
                params = [
                    id, orgId,
                    body.name ?? null,
                    body.detector_type ?? null,
                    body.pattern ?? null,
                    body.pattern_config ? JSON.stringify(body.pattern_config) : null,
                    body.action ?? null,
                    body.applies_to ? JSON.stringify(body.applies_to) : null,
                    body.is_active ?? null,
                ];
            }

            const result = await client.query(query, params);
            await invalidateCache(orgId);
            return result.rows[0];
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/dlp/rules/:id ────────────────────────────────────────
    // Deletes a custom rule. System rules cannot be deleted.
    app.delete('/v1/admin/dlp/rules/:id', { preHandler: authAdmin }, async (request, reply) => {
        const orgId  = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const existing = await client.query(
                'SELECT is_system FROM dlp_rules WHERE id = $1 AND org_id = $2',
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Regra não encontrada.' });
            }
            if (existing.rows[0].is_system) {
                return reply.status(403).send({ error: 'Regras de sistema não podem ser removidas.' });
            }

            await client.query('DELETE FROM dlp_rules WHERE id = $1 AND org_id = $2', [id, orgId]);
            await invalidateCache(orgId);
            return reply.status(204).send();
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/dlp/test ───────────────────────────────────────────────
    // Tests a text sample against the org's active DLP rules.
    // Returns detections and the sanitized text without persisting anything.
    app.post('/v1/admin/dlp/test', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const body  = request.body as { text: string; assistant_id?: string };

        if (!body.text || typeof body.text !== 'string') {
            return reply.status(400).send({ error: 'text é obrigatório.' });
        }
        if (body.text.length > 10_000) {
            return reply.status(400).send({ error: 'text não pode exceder 10.000 caracteres.' });
        }

        const result = await dlpEngine.sanitizeWithRules({
            text: body.text,
            orgId,
            assistantId: body.assistant_id ?? '',
        });

        return {
            sanitized_text: result.sanitized_text,
            blocked: result.blocked,
            block_reason: result.block_reason ?? null,
            detections: result.detections,
            detection_count: result.detections.length,
        };
    });
}
