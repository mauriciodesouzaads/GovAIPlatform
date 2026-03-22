/**
 * Consultant Auth — authorization and audit helpers for the Consultant Plane.
 *
 * Consultants operate cross-tenant: they have a home org (consultant_org_id) and
 * access one or more tenant orgs via explicit assignments stored in
 * consultant_assignments. Every action is logged to the immutable
 * consultant_audit_log table.
 */

import { Pool } from 'pg';

export interface ConsultantAssignment {
    id: string;
    tenantOrgId: string;
    roleInTenant: string;
    expiresAt: Date | null;
}

/**
 * Returns the active assignment for a consultant on a specific tenant org,
 * or null if no valid (active, non-revoked, non-expired) assignment exists.
 */
export async function getConsultantAssignment(
    pgPool: Pool,
    consultantId: string,
    tenantOrgId: string
): Promise<ConsultantAssignment | null> {
    const result = await pgPool.query(
        `SELECT id, tenant_org_id, role_in_tenant, expires_at
         FROM consultant_assignments
         WHERE consultant_id = $1
           AND tenant_org_id = $2
           AND is_active = true
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [consultantId, tenantOrgId]
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
        id: r.id,
        tenantOrgId: r.tenant_org_id,
        roleInTenant: r.role_in_tenant,
        expiresAt: r.expires_at,
    };
}

/**
 * Returns all active tenant assignments for a consultant (their "portfolio").
 */
export async function getConsultantPortfolio(
    pgPool: Pool,
    consultantId: string
): Promise<Array<{ orgId: string; orgName: string; role: string; assignedAt: Date }>> {
    const result = await pgPool.query(
        `SELECT ca.tenant_org_id as org_id, o.name as org_name,
                ca.role_in_tenant as role, ca.assigned_at
         FROM consultant_assignments ca
         JOIN organizations o ON o.id = ca.tenant_org_id
         WHERE ca.consultant_id = $1
           AND ca.is_active = true
           AND ca.revoked_at IS NULL
           AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
         ORDER BY ca.assigned_at DESC`,
        [consultantId]
    );
    return result.rows.map(r => ({
        orgId: r.org_id,
        orgName: r.org_name,
        role: r.role,
        assignedAt: r.assigned_at,
    }));
}

/**
 * Appends an immutable entry to consultant_audit_log.
 * Non-fatal: logs error but does not throw to avoid blocking the caller.
 */
export async function logConsultantAction(
    pgPool: Pool,
    consultantId: string,
    tenantOrgId: string,
    action: string,
    metadata: Record<string, unknown> = {},
    resourceType?: string,
    resourceId?: string
): Promise<void> {
    try {
        await pgPool.query(
            `INSERT INTO consultant_audit_log
             (consultant_id, tenant_org_id, action, resource_type, resource_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                consultantId,
                tenantOrgId,
                action,
                resourceType ?? null,
                resourceId ?? null,
                JSON.stringify(metadata),
            ]
        );
    } catch (err) {
        // Non-fatal: audit log failure must not block operations
        console.error('[consultant-auth] logConsultantAction failed:', err);
    }
}
