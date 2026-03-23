/**
 * Shield Export — Sprint S3
 *
 * Export estruturado de findings e postura para consultores e admins.
 * Formatos: JSON e CSV.
 *
 * Regras:
 *   - RLS respeitado via set_config(orgId, false)
 *   - Dados de um tenant nunca vazam para outro
 *   - set_config limpo no finally
 */

import { Pool } from 'pg';

export interface FindingsExportFilter {
    status?: string;
    severity?: string;
    limit?: number;
}

export interface FindingsExportResult {
    orgId: string;
    exportedAt: string;
    totalFindings: number;
    findings: Array<Record<string, unknown>>;
}

export interface PostureExportResult {
    orgId: string;
    exportedAt: string;
    latestSnapshot: Record<string, unknown> | null;
    history: Array<Record<string, unknown>>;
}

// ── exportFindingsAsJson ──────────────────────────────────────────────────────

/**
 * Exporta findings de uma org como JSON estruturado.
 * RLS: usa app.current_org_id session-level.
 * Respeita filtros opcionais de status e severity.
 */
export async function exportFindingsAsJson(
    pool: Pool,
    orgId: string,
    filter: FindingsExportFilter = {}
): Promise<FindingsExportResult> {
    const { status, severity, limit = 1000 } = filter;
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        const params: unknown[] = [orgId];
        const clauses: string[] = [];

        if (status) {
            params.push(status);
            clauses.push(`status = $${params.length}`);
        }
        if (severity) {
            params.push(severity);
            clauses.push(`severity = $${params.length}`);
        }
        params.push(limit);

        const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
        const result = await client.query(
            `SELECT id, tool_name, tool_name_normalized, severity, status,
                    rationale, risk_score, risk_dimensions, confidence,
                    recommendation, recommended_action, category,
                    first_seen_at, last_seen_at, last_action_at,
                    observation_count, unique_users,
                    source_types, correlation_count,
                    owner_candidate_hash, owner_candidate_source,
                    owner_assigned_at, dismissed_reason,
                    accepted_risk_note, promotion_candidate,
                    created_at, updated_at
             FROM shield_findings
             WHERE org_id = $1 ${where}
             ORDER BY
               CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                             WHEN 'medium' THEN 3 ELSE 4 END,
               risk_score DESC NULLS LAST
             LIMIT $${params.length}`,
            params
        );

        return {
            orgId,
            exportedAt: new Date().toISOString(),
            totalFindings: result.rows.length,
            findings: result.rows,
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── exportFindingsAsCsv ───────────────────────────────────────────────────────

/**
 * Exporta findings como CSV (UTF-8).
 * Colunas: id, tool_name, severity, status, risk_score, rationale,
 *   first_seen_at, last_seen_at, observation_count, unique_users.
 * RLS: usa app.current_org_id session-level.
 */
export async function exportFindingsAsCsv(
    pool: Pool,
    orgId: string,
    filter: FindingsExportFilter = {}
): Promise<string> {
    const { findings } = await exportFindingsAsJson(pool, orgId, filter);

    const header = [
        'id', 'tool_name', 'severity', 'status', 'risk_score',
        'observation_count', 'unique_users', 'first_seen_at', 'last_seen_at',
        'rationale',
    ].join(',');

    const csvRows = findings.map(f => [
        f.id,
        `"${String(f.tool_name ?? '').replace(/"/g, '""')}"`,
        f.severity,
        f.status,
        f.risk_score ?? '',
        f.observation_count ?? '',
        f.unique_users ?? '',
        f.first_seen_at ? new Date(f.first_seen_at as string).toISOString() : '',
        f.last_seen_at  ? new Date(f.last_seen_at  as string).toISOString() : '',
        `"${String(f.rationale ?? '').replace(/"/g, '""')}"`,
    ].join(','));

    return [header, ...csvRows].join('\n');
}

// ── exportPostureAsJson ───────────────────────────────────────────────────────

/**
 * Exporta postura Shield de uma org: snapshot mais recente + histórico (últimos 30).
 * RLS: usa app.current_org_id session-level.
 */
export async function exportPostureAsJson(
    pool: Pool,
    orgId: string
): Promise<PostureExportResult> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        const historyResult = await client.query(
            `SELECT id, generated_at, summary_score, open_findings,
                    promoted_findings, accepted_risk, unresolved_critical,
                    sanctioned_count, unsanctioned_count, total_tools,
                    coverage_ratio, top_tools, recommendations, posture
             FROM shield_posture_snapshots
             WHERE org_id = $1
             ORDER BY generated_at DESC
             LIMIT 30`,
            [orgId]
        );

        const history = historyResult.rows;
        const latestSnapshot = history.length > 0 ? history[0] : null;

        return {
            orgId,
            exportedAt: new Date().toISOString(),
            latestSnapshot,
            history,
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
