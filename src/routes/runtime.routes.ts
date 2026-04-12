/**
 * Runtime Routes — FASE 7 + FASE 8
 * ---------------------------------------------------------------------------
 * Endpoints:
 *   GET  /v1/admin/runtimes                             List profiles + availability
 *   POST /v1/admin/runtime-switch                       Record a runtime switch
 *   GET  /v1/admin/runtime-resolution/:scopeType/:scopeId  Effective runtime + source
 *   POST /v1/admin/runtime-binding                      UPSERT binding + audit trail
 *
 * All endpoints are org-scoped via JWT + RLS.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    listRuntimeProfiles,
    recordRuntimeSwitch,
    isRuntimeAvailableCached,
    resolveRuntimeForExecution,
    RuntimeProfile,
    RuntimeUnavailableError,
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
        // FASE 8: use cached availability (Redis 30s TTL) instead of
        // the sync probe so the list endpoint doesn't block on slow
        // filesystem checks for every profile on every request.
        const enriched = await Promise.all(
            profiles.map(async (p: RuntimeProfile) => ({
                slug: p.slug,
                display_name: p.display_name,
                runtime_class: p.runtime_class,
                engine_vendor: p.engine_vendor,
                engine_family: p.engine_family,
                claim_level: p.config.claim_level,
                capabilities: p.config.capabilities,
                approval: p.config.approval,
                is_default: p.is_default,
                available: await isRuntimeAvailableCached(p),
            }))
        );
        return reply.send(enriched);
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

    // ── GET /v1/admin/runtime-resolution/:scopeType/:scopeId ────────────
    // FASE 8: resolves which runtime would be used for a given scope and
    // WHY (the source layer that won). Used by the settings pages and the
    // debugging panel to show operators exactly where the binding came from.
    fastify.get('/v1/admin/runtime-resolution/:scopeType/:scopeId', {
        preHandler: readRoles,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { scopeType, scopeId } = request.params as { scopeType: string; scopeId: string };

        try {
            const resolution = await resolveRuntimeForExecution(pgPool, orgId, {
                assistantId: scopeType === 'assistant' ? scopeId : undefined,
                caseId: scopeType === 'case' ? scopeId : undefined,
                workflowTemplateId: scopeType === 'workflow_template' ? scopeId : undefined,
            });
            return reply.send({
                runtime_slug: resolution.profile.slug,
                display_name: resolution.profile.display_name,
                claim_level: resolution.claim_level,
                source: resolution.source,
                fallback_applied: resolution.fallbackApplied ?? false,
                fallback_reason: resolution.fallbackReason ?? null,
                available: true,
            });
        } catch (err: any) {
            if (err instanceof RuntimeUnavailableError) {
                return reply.status(503).send({
                    error: 'RUNTIME_UNAVAILABLE',
                    message: err.message,
                    requested_runtime: err.runtimeSlug,
                });
            }
            throw err;
        }
    });

    // ── POST /v1/admin/runtime-binding ──────────────────────────────────
    // FASE 8: UPSERT a scoped binding + audit trail. The canonical way
    // for the settings page to persist "this assistant always uses X" or
    // "this tenant defaults to Y". Replaces the direct UPDATE that the
    // /runtime-switch route did.
    fastify.post('/v1/admin/runtime-binding', {
        preHandler: writeRoles,
    }, async (request: any, reply) => {
        const { orgId, userId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        if (!userId) return reply.status(401).send({ error: 'userId ausente no token.' });

        const body = (request.body ?? {}) as {
            scope_type?: string;
            scope_id?: string;
            runtime_profile_slug?: string;
            reason?: string;
        };
        if (!body.scope_type || !body.scope_id || !body.runtime_profile_slug) {
            return reply.status(400).send({ error: 'scope_type, scope_id e runtime_profile_slug são obrigatórios.' });
        }
        if (!['tenant', 'assistant', 'workflow_template', 'case'].includes(body.scope_type)) {
            return reply.status(400).send({ error: `scope_type inválido: ${body.scope_type}` });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Resolve profile id from slug
            const rp = await client.query(
                `SELECT id, slug FROM runtime_profiles
                 WHERE slug = $1 AND (org_id = $2 OR org_id IS NULL) AND status = 'active'
                 ORDER BY org_id DESC NULLS LAST LIMIT 1`,
                [body.runtime_profile_slug, orgId]
            );
            if (!rp.rows[0]) return reply.status(404).send({ error: `Runtime slug não encontrado: ${body.runtime_profile_slug}` });

            // UPSERT binding
            await client.query(
                `INSERT INTO runtime_profile_bindings (org_id, scope_type, scope_id, runtime_profile_id, created_by)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (org_id, scope_type, scope_id)
                 DO UPDATE SET runtime_profile_id = EXCLUDED.runtime_profile_id,
                               created_by = EXCLUDED.created_by`,
                [orgId, body.scope_type, body.scope_id, rp.rows[0].id, userId]
            );

            // Also update the denormalized column when scope is assistant
            if (body.scope_type === 'assistant') {
                await client.query(
                    `UPDATE assistants SET runtime_profile_slug = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2 AND org_id = $3`,
                    [body.runtime_profile_slug, body.scope_id, orgId]
                );
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        // Audit trail
        await recordRuntimeSwitch(
            pgPool, orgId, userId,
            body.scope_type as any, body.scope_id,
            null, body.runtime_profile_slug, body.reason
        );

        return reply.send({
            bound: true,
            scope_type: body.scope_type,
            scope_id: body.scope_id,
            runtime_slug: body.runtime_profile_slug,
        });
    });
}
