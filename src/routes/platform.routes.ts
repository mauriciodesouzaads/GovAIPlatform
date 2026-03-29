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
import bcrypt from 'bcrypt';
import { OrgCreateSchema, OrgUpdateSchema, InviteAdminSchema, zodErrors } from '../lib/schemas';

export async function platformRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requirePlatformAdmin: any; [key: string]: any }
) {
    const { pgPool, requirePlatformAdmin } = opts;

    // ── Organization Management (platform_admin CRUD) ────────────────────────

    // POST /v1/admin/organizations — create new org + admin user + seed policy
    app.post('/v1/admin/organizations', { preHandler: requirePlatformAdmin }, async (request, reply) => {
        const parsed = OrgCreateSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(parsed.error) });
        }
        const { name, admin_email, admin_password, hitl_timeout_hours = 4 } = parsed.data;

        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            // Create organization
            const orgRes = await client.query<{ id: string }>(
                `INSERT INTO organizations (name, hitl_timeout_hours)
                 VALUES ($1, $2) RETURNING id`,
                [name, hitl_timeout_hours]
            );
            const orgId = orgRes.rows[0].id;

            // Hash password with bcrypt (10 rounds — same as rest of codebase)
            const passwordHash = await bcrypt.hash(admin_password, 10);

            // Create admin user (trigger auto-populates user_lookup)
            const userRes = await client.query<{ id: string }>(
                `INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, role, requires_password_change)
                 VALUES ($1, $2, $3, 'local', $4, $5, 'admin', false) RETURNING id`,
                [orgId, admin_email.toLowerCase(), admin_email.split('@')[0], admin_email.toLowerCase(), passwordHash]
            );
            const adminUserId = userRes.rows[0].id;

            // Seed GovAI base policy (minimal governance rules for new org)
            await client.query(
                `INSERT INTO policy_versions (org_id, name, rules_jsonb, version)
                 VALUES ($1, 'GovAI Base Policy', $2, 1)`,
                [orgId, JSON.stringify({
                    rules: [
                        { type: 'audit_all', enabled: true },
                        { type: 'block_pii', enabled: true },
                    ],
                    description: 'Política base gerada automaticamente no onboarding.',
                })]
            );

            await client.query('COMMIT');
            app.log.info({ orgId, adminUserId }, '[Platform] New organization created');
            return reply.status(201).send({ orgId, adminUserId });

        } catch (err: unknown) {
            await client.query('ROLLBACK').catch(() => { /* no-op */ });
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('duplicate key') || msg.includes('unique') || msg.includes('already exists')) {
                return reply.status(409).send({ error: 'Email já está em uso.' });
            }
            app.log.error(err, '[Platform] Error creating organization');
            return reply.status(500).send({ error: 'Erro ao criar organização.' });
        } finally {
            client.release();
        }
    });

    // PATCH /v1/admin/organizations/:id — update org settings (name, hitl_timeout_hours)
    app.patch('/v1/admin/organizations/:id', { preHandler: requirePlatformAdmin }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = OrgUpdateSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(parsed.error) });
        }
        const updates = parsed.data;
        if (!updates.name && updates.hitl_timeout_hours === undefined) {
            return reply.status(400).send({ error: 'Pelo menos um campo (name, hitl_timeout_hours) é obrigatório.' });
        }

        const setParts: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (updates.name !== undefined) {
            setParts.push(`name = $${idx++}`);
            values.push(updates.name);
        }
        if (updates.hitl_timeout_hours !== undefined) {
            setParts.push(`hitl_timeout_hours = $${idx++}`);
            values.push(updates.hitl_timeout_hours);
        }
        values.push(id);

        const client = await pgPool.connect();
        try {
            const res = await client.query<{ id: string; name: string; hitl_timeout_hours: number }>(
                `UPDATE organizations SET ${setParts.join(', ')} WHERE id = $${idx} RETURNING id, name, hitl_timeout_hours`,
                values
            );
            if (res.rows.length === 0) {
                return reply.status(404).send({ error: 'Organização não encontrada.' });
            }
            return reply.send(res.rows[0]);
        } catch (err: unknown) {
            app.log.error(err, '[Platform] Error updating organization');
            return reply.status(500).send({ error: 'Erro ao atualizar organização.' });
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/organizations/:id/invite-admin — add admin user to existing org
    app.post('/v1/admin/organizations/:id/invite-admin', { preHandler: requirePlatformAdmin }, async (request, reply) => {
        const { id: orgId } = request.params as { id: string };
        const parsed = InviteAdminSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(parsed.error) });
        }
        const { email, password } = parsed.data;

        const client = await pgPool.connect();
        try {
            // Verify org exists
            const orgCheck = await client.query<{ id: string }>(
                'SELECT id FROM organizations WHERE id = $1',
                [orgId]
            );
            if (orgCheck.rows.length === 0) {
                return reply.status(404).send({ error: 'Organização não encontrada.' });
            }

            const passwordHash = await bcrypt.hash(password, 10);

            const userRes = await client.query<{ id: string }>(
                `INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, role, requires_password_change)
                 VALUES ($1, $2, $3, 'local', $4, $5, 'admin', false) RETURNING id`,
                [orgId, email.toLowerCase(), email.split('@')[0], email.toLowerCase(), passwordHash]
            );

            app.log.info({ orgId, userId: userRes.rows[0].id, email }, '[Platform] Admin invited to organization');
            return reply.status(201).send({ userId: userRes.rows[0].id, orgId, email });

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('duplicate key') || msg.includes('unique') || msg.includes('already exists')) {
                return reply.status(409).send({ error: 'Email já está em uso.' });
            }
            app.log.error(err, '[Platform] Error inviting admin');
            return reply.status(500).send({ error: 'Erro ao convidar administrador.' });
        } finally {
            client.release();
        }
    });

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

    // ── Consultant Assignments (platform admin only) ──────────────────────────

    // POST /v1/admin/platform/consultant-assignments
    app.post('/v1/admin/platform/consultant-assignments', { preHandler: requirePlatformAdmin }, async (request: any, reply) => {
        const { consultantId, tenantOrgId, roleInTenant = 'observer', expiresAt, notes } = request.body as any;

        if (!consultantId || !tenantOrgId) {
            return reply.status(400).send({ error: 'consultantId e tenantOrgId são obrigatórios' });
        }

        const consultant = await pgPool.query('SELECT org_id FROM users WHERE id = $1', [consultantId]);
        if (consultant.rows.length === 0) {
            return reply.status(404).send({ error: 'Consultor não encontrado' });
        }

        const result = await pgPool.query(
            `INSERT INTO consultant_assignments
             (consultant_id, tenant_org_id, consultant_org_id, role_in_tenant,
              assigned_by, expires_at, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (consultant_id, tenant_org_id) DO UPDATE
               SET is_active = true, revoked_at = NULL, revoke_reason = NULL,
                   role_in_tenant = EXCLUDED.role_in_tenant,
                   expires_at = EXCLUDED.expires_at
             RETURNING id`,
            [consultantId, tenantOrgId, consultant.rows[0].org_id,
             roleInTenant, request.user?.userId ?? null, expiresAt ?? null, notes ?? null]
        );

        return reply.status(201).send({ id: result.rows[0].id, consultantId, tenantOrgId });
    });

    // GET /v1/admin/platform/consultant-assignments
    app.get('/v1/admin/platform/consultant-assignments', { preHandler: requirePlatformAdmin }, async (_request, reply) => {
        const result = await pgPool.query(
            `SELECT ca.id, ca.consultant_id, ca.tenant_org_id, ca.role_in_tenant,
                    ca.is_active, ca.assigned_at, ca.expires_at,
                    u.email as consultant_email,
                    o.name as tenant_name
             FROM consultant_assignments ca
             JOIN users u ON u.id = ca.consultant_id
             JOIN organizations o ON o.id = ca.tenant_org_id
             ORDER BY ca.assigned_at DESC`
        );
        return reply.send({ assignments: result.rows });
    });

    // DELETE /v1/admin/platform/consultant-assignments/:id
    app.delete('/v1/admin/platform/consultant-assignments/:id', { preHandler: requirePlatformAdmin }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { reason } = (request.body as any) ?? {};

        const result = await pgPool.query(
            `UPDATE consultant_assignments
             SET is_active = false, revoked_at = NOW(), revoke_reason = $1
             WHERE id = $2 AND is_active = true
             RETURNING consultant_id, tenant_org_id`,
            [reason ?? 'Revogado pelo platform admin', id]
        );

        if (result.rowCount === 0) {
            return reply.status(404).send({ error: 'Assignment não encontrado ou já revogado' });
        }

        return reply.send({ success: true, id });
    });

    // POST /v1/admin/platform/consultant-alerts
    app.post('/v1/admin/platform/consultant-alerts', { preHandler: requirePlatformAdmin }, async (request: any, reply) => {
        const { consultantId, tenantOrgId, alertType, severity = 'medium',
                title, description, expiresAt } = request.body as any;

        if (!consultantId || !tenantOrgId || !alertType || !title) {
            return reply.status(400).send({ error: 'consultantId, tenantOrgId, alertType e title são obrigatórios' });
        }

        const result = await pgPool.query(
            `INSERT INTO consultant_alerts
             (consultant_id, tenant_org_id, alert_type, severity, title, description, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [consultantId, tenantOrgId, alertType, severity,
             title, description ?? null, expiresAt ?? null]
        );

        return reply.status(201).send({ id: result.rows[0].id });
    });
}
