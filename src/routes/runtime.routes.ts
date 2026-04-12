/**
 * Runtime Routes — FASE 7
 * ---------------------------------------------------------------------------
 * Endpoints:
 *   GET  /v1/admin/runtimes         List available runtime profiles + availability
 *   POST /v1/admin/runtime-switch   Record a runtime switch (assistant/tenant/...)
 *
 * Both endpoints are org-scoped via JWT. RLS ensures tenants can't see each
 * other's overrides. Global rows (org_id IS NULL) are always visible.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    listRuntimeProfiles,
    recordRuntimeSwitch,
    isRuntimeAvailable,
    RuntimeProfile,
} from '../lib/runtime-profiles';

export async function runtimeRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;

    const readRoles = requireRole(['admin', 'operator', 'dpo', 'auditor']);
    const writeRoles = requireRole(['admin', 'operator']);

    // ── GET /v1/admin/runtimes ────────────────────────────────────────────────
    // Returns the runtime catalog visible to this org, annotated with an
    // `available` flag derived from the runner's configured env vars /
    // unix socket. A profile that's 'available=false' is rendered in the
    // UI as "Indisponível" so operators know they need to bring up the
    // container before selecting it.
    fastify.get('/v1/admin/runtimes', { preHandler: readRoles }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const profiles = await listRuntimeProfiles(pgPool, orgId);
        return reply.send(
            profiles.map((p: RuntimeProfile) => ({
                slug: p.slug,
                display_name: p.display_name,
                runtime_class: p.runtime_class,
                engine_vendor: p.engine_vendor,
                engine_family: p.engine_family,
                claim_level: p.config.claim_level,
                capabilities: p.config.capabilities,
                approval: p.config.approval,
                is_default: p.is_default,
                available: isRuntimeAvailable(p),
            }))
        );
    });

    // ── POST /v1/admin/runtime-switch ────────────────────────────────────────
    // Records the switch in runtime_switch_audit AND (when scope_type is
    // 'assistant') persists the new preference on assistants.runtime_profile_slug.
    //
    // Body:
    //   {
    //     scope_type: 'assistant' | 'tenant' | 'template' | 'case' | 'work_item',
    //     scope_id:   uuid,
    //     runtime_slug: 'openclaude' | 'claude_code_official' | ...,
    //     reason?: string
    //   }
    fastify.post('/v1/admin/runtime-switch', { preHandler: writeRoles }, async (request: any, reply) => {
        const { orgId, userId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        if (!userId) return reply.status(401).send({ error: 'userId ausente no token.' });

        const body = (request.body ?? {}) as {
            scope_type?: string;
            scope_id?: string;
            runtime_slug?: string;
            reason?: string;
        };

        if (!body.scope_type || !body.scope_id || !body.runtime_slug) {
            return reply.status(400).send({
                error: 'scope_type, scope_id e runtime_slug são obrigatórios.',
            });
        }
        if (!['tenant', 'assistant', 'template', 'case', 'work_item'].includes(body.scope_type)) {
            return reply.status(400).send({ error: `scope_type inválido: ${body.scope_type}` });
        }

        // Validate the target runtime exists and is active for this org.
        const profiles = await listRuntimeProfiles(pgPool, orgId);
        const target = profiles.find(p => p.slug === body.runtime_slug);
        if (!target) {
            return reply.status(404).send({ error: `Runtime slug não encontrado: ${body.runtime_slug}` });
        }

        // When scoping to an assistant, update the preference column AND
        // capture the previous slug so the audit trail is meaningful.
        // Everything happens inside a single transaction so the audit
        // insert never lies about the "from" state.
        let fromSlug: string | null = null;
        if (body.scope_type === 'assistant') {
            const client = await pgPool.connect();
            try {
                await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                await client.query('BEGIN');

                const cur = await client.query(
                    `SELECT runtime_profile_slug FROM assistants WHERE id = $1 AND org_id = $2`,
                    [body.scope_id, orgId]
                );
                if (cur.rows.length === 0) {
                    await client.query('ROLLBACK').catch(() => {});
                    return reply.status(404).send({ error: 'Assistente não encontrado' });
                }
                fromSlug = cur.rows[0].runtime_profile_slug ?? null;

                await client.query(
                    `UPDATE assistants
                     SET runtime_profile_slug = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2 AND org_id = $3`,
                    [body.runtime_slug, body.scope_id, orgId]
                );
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                client.release();
            }
        }

        // Non-assistant scopes are still audited — they just don't mutate
        // any preference column today. Future scopes (tenant-wide default,
        // template override) will add their own UPDATE branches here.
        await recordRuntimeSwitch(
            pgPool,
            orgId,
            userId,
            body.scope_type as any,
            body.scope_id,
            fromSlug,
            body.runtime_slug,
            body.reason
        );

        return reply.send({
            switched: true,
            from: fromSlug,
            to: body.runtime_slug,
            scope_type: body.scope_type,
            scope_id: body.scope_id,
        });
    });
}
