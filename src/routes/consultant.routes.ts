/**
 * Consultant Plane Routes — cross-tenant read access for authorized consultants.
 *
 * Security model:
 *   - Consultant must have an active, non-expired consultant_assignment record
 *     for the requested tenant_org_id.
 *   - Every access is logged to the immutable consultant_audit_log table.
 *   - Every access also generates an evidence_record (category: data_access).
 *   - No write operations on tenant data — read-only view plane.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    getConsultantAssignment,
    getConsultantPortfolio,
    logConsultantAction,
} from '../lib/consultant-auth';
import { recordEvidence } from '../lib/evidence';

export async function consultantRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireTenantRole: any }
) {
    const { pgPool, requireTenantRole } = opts;

    // ── GET /v1/consultant/portfolio ─────────────────────────────────────────
    // Returns all active tenant assignments for the authenticated consultant.
    fastify.get('/v1/consultant/portfolio', {
        preHandler: requireTenantRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user;

        const portfolio = await getConsultantPortfolio(pgPool, userId);

        await logConsultantAction(pgPool, userId, orgId, 'PORTFOLIO_VIEW', {
            tenant_count: portfolio.length,
        });

        return reply.send({ tenants: portfolio, total: portfolio.length });
    });

    // ── GET /v1/consultant/tenants/:tenantOrgId/summary ──────────────────────
    // Returns an executive summary of a tenant org the consultant is assigned to.
    // Enforces: valid assignment required (403 if absent or expired).
    fastify.get('/v1/consultant/tenants/:tenantOrgId/summary', {
        preHandler: requireTenantRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId, email } = request.user;
        const { tenantOrgId } = request.params as { tenantOrgId: string };

        // Authorization check — must have active assignment for this tenant
        const assignment = await getConsultantAssignment(pgPool, userId, tenantOrgId);
        if (!assignment) {
            return reply.status(403).send({
                error: 'Acesso negado. Sem atribuição ativa para este tenant.',
            });
        }

        const client = await pgPool.connect();
        try {
            // Scoped to tenant via session-local set_config (true = local to transaction)
            await client.query(
                "SELECT set_config('app.current_org_id', $1, true)", [tenantOrgId]
            );

            const [orgResult, assistantsResult, approvalsResult, violationsResult] =
                await Promise.all([
                    client.query(
                        'SELECT id, name, telemetry_consent FROM organizations WHERE id = $1',
                        [tenantOrgId]
                    ),
                    client.query(
                        `SELECT COUNT(*) as total,
                                COUNT(*) FILTER (WHERE lifecycle_state = 'official') as official,
                                COUNT(*) FILTER (WHERE lifecycle_state = 'under_review') as under_review
                         FROM assistants WHERE org_id = $1`,
                        [tenantOrgId]
                    ),
                    client.query(
                        `SELECT COUNT(*) as pending FROM pending_approvals
                         WHERE org_id = $1 AND status = 'pending'`,
                        [tenantOrgId]
                    ),
                    client.query(
                        `SELECT COUNT(*) as violations FROM evidence_records
                         WHERE org_id = $1 AND event_type = 'POLICY_VIOLATION'
                           AND created_at > NOW() - INTERVAL '7 days'`,
                        [tenantOrgId]
                    ),
                ]);

            // Immutable audit entries (non-fatal)
            await logConsultantAction(pgPool, userId, tenantOrgId, 'TENANT_VIEW', {
                role: assignment.roleInTenant,
            });
            await recordEvidence(pgPool, {
                orgId,
                category: 'data_access',
                eventType: 'CONSULTANT_TENANT_VIEW',
                actorId: userId,
                actorEmail: email ?? null,
                resourceType: 'organization',
                resourceId: tenantOrgId,
                metadata: { role: assignment.roleInTenant },
            });

            return reply.send({
                organization: orgResult.rows[0],
                assistants: assistantsResult.rows[0],
                pendingApprovals: parseInt(approvalsResult.rows[0].pending, 10),
                violationsLast7Days: parseInt(violationsResult.rows[0].violations, 10),
                consultantRole: assignment.roleInTenant,
                assignmentExpiresAt: assignment.expiresAt,
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', true)");
            client.release();
        }
    });

    // ── GET /v1/consultant/alerts ────────────────────────────────────────────
    // Returns all alerts for the authenticated consultant across all tenants.
    // Query params: severity?, acknowledged? (boolean)
    fastify.get('/v1/consultant/alerts', {
        preHandler: requireTenantRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId } = request.user;
        const { severity, acknowledged } = request.query as {
            severity?: string;
            acknowledged?: string;
        };

        const acknowledgedBool = acknowledged === undefined
            ? null
            : acknowledged === 'true';

        const result = await pgPool.query(
            `SELECT ca.id, ca.alert_type, ca.severity, ca.title, ca.description,
                    ca.resource_type, ca.resource_id, ca.acknowledged_at,
                    ca.created_at, ca.expires_at, o.name as tenant_name
             FROM consultant_alerts ca
             JOIN organizations o ON o.id = ca.tenant_org_id
             WHERE ca.consultant_id = $1
               AND ($2::text IS NULL OR ca.severity = $2)
               AND ($3::boolean IS NULL OR
                    CASE WHEN $3 THEN ca.acknowledged_at IS NOT NULL
                         ELSE ca.acknowledged_at IS NULL END)
               AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
             ORDER BY
               CASE ca.severity
                 WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                 WHEN 'medium'   THEN 3 ELSE 4
               END,
               ca.created_at DESC
             LIMIT 100`,
            [userId, severity ?? null, acknowledgedBool]
        );

        return reply.send({ alerts: result.rows, total: result.rows.length });
    });

    // ── POST /v1/consultant/alerts/:alertId/acknowledge ──────────────────────
    // Marks an alert as acknowledged. Only the assigned consultant can acknowledge.
    fastify.post('/v1/consultant/alerts/:alertId/acknowledge', {
        preHandler: requireTenantRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId } = request.user;
        const { alertId } = request.params as { alertId: string };

        const result = await pgPool.query(
            `UPDATE consultant_alerts
             SET acknowledged_at = NOW(), acknowledged_by = $1
             WHERE id = $2
               AND consultant_id = $1
               AND acknowledged_at IS NULL
             RETURNING id, tenant_org_id`,
            [userId, alertId]
        );

        if (result.rowCount === 0) {
            return reply.status(404).send({
                error: 'Alerta não encontrado ou já reconhecido.',
            });
        }

        await logConsultantAction(
            pgPool, userId, result.rows[0].tenant_org_id,
            'ALERT_ACKNOWLEDGED', { alertId }
        );

        return reply.send({ success: true, alertId });
    });

    // ── GET /v1/consultant/tenants/:tenantOrgId/audit-log ───────────────────
    // Returns the consultant's own action history for a specific tenant.
    fastify.get('/v1/consultant/tenants/:tenantOrgId/audit-log', {
        preHandler: requireTenantRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId } = request.user;
        const { tenantOrgId } = request.params as { tenantOrgId: string };

        const assignment = await getConsultantAssignment(pgPool, userId, tenantOrgId);
        if (!assignment) {
            return reply.status(403).send({ error: 'Acesso negado.' });
        }

        const result = await pgPool.query(
            `SELECT action, resource_type, resource_id, metadata, created_at
             FROM consultant_audit_log
             WHERE consultant_id = $1 AND tenant_org_id = $2
             ORDER BY created_at DESC LIMIT 50`,
            [userId, tenantOrgId]
        );

        return reply.send({ entries: result.rows, total: result.rows.length });
    });

    // ── GET /v1/consultant/tenants/:tenantOrgId/shield/posture ────────────────
    // Postura de risco Shield de um tenant — somente leitura.
    // Requer assignment ativo para o tenant.
    fastify.get('/v1/consultant/tenants/:tenantOrgId/shield/posture', {
        preHandler: requireTenantRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId } = request.user;
        const { tenantOrgId } = request.params as { tenantOrgId: string };

        const assignment = await getConsultantAssignment(pgPool, userId, tenantOrgId);
        if (!assignment) return reply.status(403).send({ error: 'Acesso negado.' });

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [tenantOrgId]
            );
            const snap = await client.query(
                `SELECT id, generated_at, summary_score, open_findings,
                        promoted_findings, accepted_risk, top_tools, recommendations
                 FROM shield_posture_snapshots
                 WHERE org_id = $1
                 ORDER BY generated_at DESC LIMIT 1`,
                [tenantOrgId]
            );

            await logConsultantAction(pgPool, userId, tenantOrgId, 'SHIELD_POSTURE_VIEW', {});

            return reply.send(snap.rows[0] ?? { message: 'Nenhum snapshot disponível.' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/consultant/tenants/:tenantOrgId/shield/findings ──────────────
    // Findings Shield do tenant — somente leitura.
    // Requer assignment ativo para o tenant.
    fastify.get('/v1/consultant/tenants/:tenantOrgId/shield/findings', {
        preHandler: requireTenantRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId } = request.user;
        const { tenantOrgId } = request.params as { tenantOrgId: string };
        const { status, severity, limit } = request.query as any;

        const assignment = await getConsultantAssignment(pgPool, userId, tenantOrgId);
        if (!assignment) return reply.status(403).send({ error: 'Acesso negado.' });

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [tenantOrgId]
            );

            const params: any[] = [tenantOrgId];
            const clauses: string[] = [];
            if (status)   { params.push(status);   clauses.push(`status = $${params.length}`); }
            if (severity) { params.push(severity); clauses.push(`severity = $${params.length}`); }
            params.push(Math.min(parseInt(limit ?? '50', 10), 100));

            const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
            const findings = await client.query(
                `SELECT id, tool_name, severity, status, risk_score, rationale,
                        first_seen_at, last_seen_at, observation_count, unique_users
                 FROM shield_findings
                 WHERE org_id = $1 ${where}
                 ORDER BY risk_score DESC NULLS LAST, last_seen_at DESC
                 LIMIT $${params.length}`,
                params
            );

            await logConsultantAction(pgPool, userId, tenantOrgId, 'SHIELD_FINDINGS_VIEW', {
                status, severity, count: findings.rows.length,
            });

            return reply.send({ findings: findings.rows, total: findings.rows.length });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
}
