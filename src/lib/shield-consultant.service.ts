/**
 * Shield Consultant Service
 *
 * Postura Shield para visualização consultiva.
 */

import { Pool } from 'pg';

// ── listShieldPostureForConsultant (Sprint S2) ────────────────────────────────

/**
 * Retorna postura Shield de um tenant para visualização consultiva.
 * Requer que o caller já tenha validado o consultant assignment (403 se nulo).
 * Usa set_config(tenantOrgId, false) internamente — limpa no finally.
 */
export async function listShieldPostureForConsultant(
    pool: Pool,
    tenantOrgId: string
): Promise<{
    openFindings: number;
    criticalFindings: number;
    promotedFindings: number;
    acceptedRiskFindings: number;
    topTools: Array<{ toolName: string; score: number; severity: string }>;
    latestSnapshotAt: Date | null;
}> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [tenantOrgId]
        );

        const counts = await client.query(
            `SELECT
               COUNT(*) FILTER (WHERE status IN ('open','acknowledged'))   AS open_count,
               COUNT(*) FILTER (WHERE severity = 'critical'
                                  AND status IN ('open','acknowledged'))    AS critical_count,
               COUNT(*) FILTER (WHERE status = 'promoted')                 AS promoted_count,
               COUNT(*) FILTER (WHERE status = 'accepted_risk')            AS accepted_count
             FROM shield_findings
             WHERE org_id = $1`,
            [tenantOrgId]
        );
        const c = counts.rows[0];

        const topToolsResult = await client.query(
            `SELECT tool_name, COALESCE(risk_score, 0) AS risk_score, severity
             FROM shield_findings
             WHERE org_id = $1 AND status IN ('open','acknowledged')
             ORDER BY risk_score DESC NULLS LAST
             LIMIT 5`,
            [tenantOrgId]
        );

        const snapResult = await client.query(
            `SELECT generated_at FROM shield_posture_snapshots
             WHERE org_id = $1 ORDER BY generated_at DESC LIMIT 1`,
            [tenantOrgId]
        );

        return {
            openFindings:        parseInt(c.open_count     ?? '0'),
            criticalFindings:    parseInt(c.critical_count ?? '0'),
            promotedFindings:    parseInt(c.promoted_count ?? '0'),
            acceptedRiskFindings: parseInt(c.accepted_count ?? '0'),
            topTools: topToolsResult.rows.map(r => ({
                toolName: r.tool_name as string,
                score:    r.risk_score as number,
                severity: r.severity as string,
            })),
            latestSnapshotAt: snapResult.rows[0]?.generated_at ?? null,
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
