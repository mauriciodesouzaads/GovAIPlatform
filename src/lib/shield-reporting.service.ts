/**
 * Shield Reporting Service
 *
 * Geração de postura executiva persistida em shield_posture_snapshots.
 */

import { Pool } from 'pg';

// ── generateExecutivePosture ──────────────────────────────────────────────────

/**
 * Gera e persiste um snapshot de postura executiva em shield_posture_snapshots.
 * Consolida: findings por severidade/status, top tools, promoted, accepted_risk.
 * Retorna estrutura pronta para API/relatório.
 *
 * Não requer app.current_org_id externo — configura e limpa internamente.
 */
export async function generateExecutivePosture(
    pool: Pool,
    orgId: string,
    generatedBy: string
): Promise<{
    snapshotId: string;
    summaryScore: number;
    openFindings: number;
    promotedFindings: number;
    acceptedRisk: number;
    unresolvedCritical: number;
    topTools: Array<{ toolName: string; score: number; severity: string }>;
    recommendations: string[];
}> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        // Contagens de findings por status
        const counts = await client.query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'open')          AS open_count,
               COUNT(*) FILTER (WHERE status = 'acknowledged')  AS ack_count,
               COUNT(*) FILTER (WHERE status = 'promoted')      AS promoted_count,
               COUNT(*) FILTER (WHERE status = 'accepted_risk') AS accepted_count,
               COUNT(*) FILTER (WHERE severity = 'critical')    AS critical_count,
               COUNT(*) FILTER (WHERE severity = 'high')        AS high_count,
               COUNT(*) FILTER (
                   WHERE severity = 'critical'
                     AND status NOT IN ('dismissed','resolved','promoted')
               ) AS unresolved_critical_count,
               COALESCE(AVG(risk_score), 0)::int                AS avg_score
             FROM shield_findings
             WHERE org_id = $1 AND status IN ('open','acknowledged','accepted_risk')`,
            [orgId]
        );

        const c = counts.rows[0];
        const openFindings       = parseInt(c.open_count ?? '0') + parseInt(c.ack_count ?? '0');
        const promotedFindings   = parseInt(c.promoted_count ?? '0');
        const acceptedRisk       = parseInt(c.accepted_count ?? '0');
        const unresolvedCritical = parseInt(c.unresolved_critical_count ?? '0');
        const summaryScore       = c.avg_score ?? 0;
        const criticalCount      = parseInt(c.critical_count ?? '0');
        const highCount          = parseInt(c.high_count ?? '0');

        // Top tools por risk_score
        const topToolsResult = await client.query(
            `SELECT tool_name, COALESCE(risk_score, 0) AS risk_score, severity
             FROM shield_findings
             WHERE org_id = $1 AND status IN ('open','acknowledged')
             ORDER BY risk_score DESC NULLS LAST
             LIMIT 5`,
            [orgId]
        );
        const topTools = topToolsResult.rows.map(r => ({
            toolName: r.tool_name as string,
            score:    r.risk_score as number,
            severity: r.severity as string,
        }));

        // Sanctioned vs unsanctioned (Sprint S3)
        const toolsCount = await client.query(
            `SELECT
               COUNT(*)                                          AS total,
               COUNT(*) FILTER (WHERE sanctioned = true)        AS sanctioned,
               COUNT(*) FILTER (WHERE sanctioned IS DISTINCT FROM true) AS unsanctioned,
               COUNT(*) FILTER (WHERE approval_status != 'unknown') AS governed
             FROM shield_tools WHERE org_id = $1`,
            [orgId]
        );
        const tc = toolsCount.rows[0];
        const sanctionedCount   = parseInt(tc?.sanctioned   ?? '0');
        const unsanctionedCount = parseInt(tc?.unsanctioned ?? '0');
        const totalTools        = parseInt(tc?.total        ?? '0');
        const governedTools     = parseInt(tc?.governed     ?? '0');
        const coverageRatio     = totalTools > 0
            ? parseFloat((governedTools / totalTools).toFixed(4))
            : null;

        // Recomendações dinâmicas
        const recommendations: string[] = [];
        if (criticalCount > 0)
            recommendations.push(`${criticalCount} ferramenta(s) de risco crítico requerem ação imediata.`);
        if (highCount > 0)
            recommendations.push(`Iniciar catalogação para ${highCount} ferramenta(s) de alto risco.`);
        if (promotedFindings > 0)
            recommendations.push(`${promotedFindings} ferramenta(s) promovida(s) ao catálogo aguardam revisão.`);
        if (unsanctionedCount > 0)
            recommendations.push(`${unsanctionedCount} ferramenta(s) não sancionada(s) — revisar política de uso.`);
        if (recommendations.length === 0)
            recommendations.push('Nenhuma ação crítica pendente. Manter monitoramento.');

        // Persistir snapshot (com métricas de cobertura S3)
        const snap = await client.query(
            `INSERT INTO shield_posture_snapshots
             (org_id, posture, summary_score, open_findings,
              promoted_findings, accepted_risk, top_tools, recommendations,
              unresolved_critical, sanctioned_count, unsanctioned_count,
              total_tools, coverage_ratio)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING id`,
            [
                orgId,
                JSON.stringify({ criticalCount, highCount, summaryScore, generatedBy }),
                summaryScore,
                openFindings,
                promotedFindings,
                acceptedRisk,
                JSON.stringify(topTools),
                JSON.stringify(recommendations),
                unresolvedCritical,
                sanctionedCount,
                unsanctionedCount,
                totalTools,
                coverageRatio,
            ]
        );
        const snapshotId = snap.rows[0].id as string;

        return { snapshotId, summaryScore, openFindings, promotedFindings, acceptedRisk, unresolvedCritical, topTools, recommendations };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
