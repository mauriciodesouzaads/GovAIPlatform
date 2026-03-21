/**
 * Platform Routes — Control-plane views for platform_admin role.
 *
 * These routes operate outside tenant scope (no RLS, no x-org-id required).
 * They are protected by requirePlatformAdmin middleware and must never be
 * accessible to tenant-scoped admin users.
 *
 * Extracted from admin.routes.ts (B4 refactoring — admin.routes.ts > 600 lines).
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

export async function platformRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requirePlatformAdmin: any; [key: string]: any }
) {
    const { pgPool, requirePlatformAdmin } = opts;

    // GET /v1/admin/platform/organizations — all orgs across all tenants
    app.get('/v1/admin/platform/organizations', { preHandler: requirePlatformAdmin }, async (_request, reply) => {
        const client = await pgPool.connect();
        try {
            const res = await client.query(
                `SELECT id, name, telemetry_consent, telemetry_consent_at, telemetry_pii_strip, sso_tenant_id, created_at
                 FROM organizations
                 ORDER BY created_at DESC`
            );
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, 'Error fetching platform organizations');
            return reply.status(500).send({ error: 'Erro ao buscar organizações da plataforma.' });
        } finally {
            client.release();
        }
    });

    // GET /v1/admin/platform/users — all users across all tenants
    app.get('/v1/admin/platform/users', { preHandler: requirePlatformAdmin }, async (_request, reply) => {
        const client = await pgPool.connect();
        try {
            const res = await client.query(
                `SELECT id, email, org_id, role, status, sso_provider, created_at
                 FROM users
                 ORDER BY created_at DESC`
            );
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, 'Error fetching platform users');
            return reply.status(500).send({ error: 'Erro ao buscar usuários da plataforma.' });
        } finally {
            client.release();
        }
    });
}
