/**
 * Shield Metrics / SLOs — Sprint S3
 *
 * Métricas operacionais do módulo Shield.
 * Calcula a partir dos dados existentes (não requer tabela de métricas separada).
 *
 * Métricas disponíveis:
 *   - collector success rates (por tipo)
 *   - finding freshness (idade média de findings abertos)
 *   - processing backlog (observações não processadas)
 *   - promotion latency (aproximação: dias em aberto até promoted)
 *   - posture generation count (snapshots nos últimos 30 dias)
 *   - sanctioned vs unsanctioned coverage ratio
 *
 * Regras:
 *   - set_config(..., false) — session-level, limpar no finally
 *   - Métricas são read-only, não alteram dados
 */

import { Pool } from 'pg';

export interface CollectorSuccessRate {
    kind: string;
    collectorId: string;
    collectorName: string;
    successCount: number;
    failureCount: number;
    successRate: number | null;  // null se sem execuções
    healthStatus: string;
}

export interface ShieldMetrics {
    orgId: string;
    computedAt: string;
    collectorSuccessRates: CollectorSuccessRate[];
    findingFreshnessAvgDays: number | null;   // null se sem findings abertos
    processingBacklog: number;                 // observações não processadas
    promotionLatencyAvgDays: number | null;    // null se sem promoted findings
    postureGenerationsLast30Days: number;
    coverageRatio: number | null;              // governado/detectado, null se sem tools
    openFindings: number;
    criticalUnresolved: number;
}

// ── computeShieldMetrics ──────────────────────────────────────────────────────

/**
 * Calcula métricas operacionais Shield para uma org.
 * Não requer set_config externo — configura e limpa internamente.
 */
export async function computeShieldMetrics(
    pool: Pool,
    orgId: string
): Promise<ShieldMetrics> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        // Collector success rates — OAuth
        const oauthRates = await client.query(
            `SELECT id, provider AS collector_name, success_count, failure_count, health_status
             FROM shield_oauth_collectors WHERE org_id = $1`,
            [orgId]
        );

        // Collector success rates — Google
        const googleRates = await client.query(
            `SELECT id, collector_name, success_count, failure_count, health_status
             FROM shield_google_collectors WHERE org_id = $1`,
            [orgId]
        );

        // Collector success rates — Network
        const networkRates = await client.query(
            `SELECT id, collector_name, success_count, failure_count, health_status
             FROM shield_network_collectors WHERE org_id = $1`,
            [orgId]
        );

        const collectorSuccessRates: CollectorSuccessRate[] = [];
        for (const [rows, kind] of [
            [oauthRates.rows, 'oauth'],
            [googleRates.rows, 'google'],
            [networkRates.rows, 'network'],
        ] as Array<[any[], string]>) {
            for (const r of rows) {
                const total = (r.success_count as number) + (r.failure_count as number);
                collectorSuccessRates.push({
                    kind,
                    collectorId:   r.id,
                    collectorName: r.collector_name,
                    successCount:  r.success_count,
                    failureCount:  r.failure_count,
                    successRate:   total > 0 ? r.success_count / total : null,
                    healthStatus:  r.health_status,
                });
            }
        }

        // Finding freshness — avg age of open findings (days)
        const freshnessResult = await client.query(
            `SELECT AVG(EXTRACT(EPOCH FROM (NOW() - first_seen_at)) / 86400) AS avg_days,
                    COUNT(*) AS open_count,
                    COUNT(*) FILTER (WHERE severity = 'critical') AS critical_count
             FROM shield_findings
             WHERE org_id = $1 AND status IN ('open','acknowledged')`,
            [orgId]
        );
        const fr = freshnessResult.rows[0];
        const findingFreshnessAvgDays = fr.avg_days !== null ? parseFloat(fr.avg_days) : null;
        const openFindings    = parseInt(fr.open_count ?? '0');
        const criticalUnresolved = parseInt(fr.critical_count ?? '0');

        // Processing backlog
        const backlogResult = await client.query(
            `SELECT COUNT(*)::int AS backlog
             FROM shield_observations_raw
             WHERE org_id = $1 AND processed = false`,
            [orgId]
        );
        const processingBacklog = backlogResult.rows[0]?.backlog ?? 0;

        // Promotion latency — avg days from first_seen_at to last_seen_at for promoted findings
        const promotionResult = await client.query(
            `SELECT AVG(
                       EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)) / 86400
                   ) AS avg_days
             FROM shield_findings
             WHERE org_id = $1 AND status = 'promoted'
               AND last_seen_at IS NOT NULL AND first_seen_at IS NOT NULL`,
            [orgId]
        );
        const promotionLatencyAvgDays = promotionResult.rows[0]?.avg_days !== null
            ? parseFloat(promotionResult.rows[0].avg_days)
            : null;

        // Posture generation count (last 30 days)
        const postureResult = await client.query(
            `SELECT COUNT(*)::int AS cnt
             FROM shield_posture_snapshots
             WHERE org_id = $1 AND generated_at >= NOW() - INTERVAL '30 days'`,
            [orgId]
        );
        const postureGenerationsLast30Days = postureResult.rows[0]?.cnt ?? 0;

        // Coverage ratio — governed / total tools
        const toolsResult = await client.query(
            `SELECT
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE approval_status != 'unknown') AS governed
             FROM shield_tools WHERE org_id = $1`,
            [orgId]
        );
        const tt = toolsResult.rows[0];
        const totalTools = parseInt(tt?.total ?? '0');
        const governedTools = parseInt(tt?.governed ?? '0');
        const coverageRatio = totalTools > 0
            ? parseFloat((governedTools / totalTools).toFixed(4))
            : null;

        return {
            orgId,
            computedAt: new Date().toISOString(),
            collectorSuccessRates,
            findingFreshnessAvgDays,
            processingBacklog,
            promotionLatencyAvgDays,
            postureGenerationsLast30Days,
            coverageRatio,
            openFindings,
            criticalUnresolved,
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
