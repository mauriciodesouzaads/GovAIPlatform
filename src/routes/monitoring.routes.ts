import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

export async function monitoringRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;
    const auth = requireRole(['admin', 'dpo', 'auditor', 'compliance']);
    const authAdmin = requireRole(['admin']);

    // ── GET /v1/admin/monitoring/realtime ──────────────────────────────────
    // Returns KPIs for the last 60 minutes + top assistants by volume.
    // Response shape matches the frontend RealtimeData interface.
    app.get('/v1/admin/monitoring/realtime', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Aggregate KPIs for the last 60 min
            const totals = await client.query(`
                SELECT
                    COUNT(*) FILTER (WHERE action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR')) AS total_executions,
                    COUNT(*) FILTER (WHERE action = 'POLICY_VIOLATION') AS total_violations,
                    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (
                        ORDER BY (metadata->>'latency_ms')::numeric
                    ) FILTER (WHERE metadata->>'latency_ms' IS NOT NULL AND action = 'EXECUTION_SUCCESS'), 0) AS latency_p95,
                    COALESCE(SUM((metadata->>'tokens')::numeric) FILTER (WHERE metadata->>'tokens' IS NOT NULL), 0) AS total_tokens,
                    COALESCE(SUM((metadata->>'cost')::numeric) FILTER (WHERE metadata->>'cost' IS NOT NULL), 0) AS total_cost
                FROM audit_logs_partitioned
                WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '60 minutes'
            `, [orgId]);

            // Daily cost (today, not just the last 60 min)
            const dailyCostRow = await client.query(`
                SELECT COALESCE(SUM((metadata->>'cost')::numeric), 0) AS daily_cost
                FROM audit_logs_partitioned
                WHERE org_id = $1 AND created_at >= CURRENT_DATE
                    AND metadata->>'cost' IS NOT NULL
            `, [orgId]);

            // Per-assistant breakdown for last 60 min
            const byAssistant = await client.query(`
                SELECT
                    al.assistant_id,
                    a.name AS assistant_name,
                    COUNT(*) FILTER (WHERE al.action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR')) AS exec_count,
                    COUNT(*) FILTER (WHERE al.action = 'POLICY_VIOLATION') AS violation_count,
                    COALESCE(AVG((al.metadata->>'latency_ms')::numeric)
                        FILTER (WHERE al.metadata->>'latency_ms' IS NOT NULL AND al.action = 'EXECUTION_SUCCESS'), 0) AS avg_latency_ms,
                    COALESCE(SUM((al.metadata->>'cost')::numeric) FILTER (WHERE al.metadata->>'cost' IS NOT NULL), 0) AS total_cost_usd
                FROM audit_logs_partitioned al
                LEFT JOIN assistants a ON al.assistant_id = a.id
                WHERE al.org_id = $1 AND al.created_at >= NOW() - INTERVAL '60 minutes'
                GROUP BY al.assistant_id, a.name
                ORDER BY exec_count DESC
                LIMIT 10
            `, [orgId]);

            return {
                executions_last_hour: parseInt(totals.rows[0].total_executions) || 0,
                violations_last_hour: parseInt(totals.rows[0].total_violations) || 0,
                latency_p95_ms: Math.round(parseFloat(totals.rows[0].latency_p95) || 0),
                daily_cost_usd: Math.round(parseFloat(dailyCostRow.rows[0].daily_cost) * 100) / 100,
                top_assistants: byAssistant.rows.map(r => ({
                    assistant_id: r.assistant_id,
                    assistant_name: r.assistant_name || 'Desconhecido',
                    exec_count: parseInt(r.exec_count) || 0,
                    violation_count: parseInt(r.violation_count) || 0,
                    avg_latency_ms: Math.round(parseFloat(r.avg_latency_ms) || 0),
                    total_cost_usd: Math.round(parseFloat(r.total_cost_usd) * 1000) / 1000,
                })),
            };
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/monitoring/trends ───────────────────────────────────
    // Returns time-series data over N days.
    // Response shape matches the frontend TrendsData interface.
    app.get('/v1/admin/monitoring/trends', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const days = Math.min(90, Math.max(7, parseInt((request.query as any).days || '30')));
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Executions + violations with zero-filling via generate_series
            const execTrend = await client.query(`
                WITH date_series AS (
                    SELECT generate_series(
                        (CURRENT_DATE - ($2 || ' days')::interval)::date,
                        CURRENT_DATE,
                        '1 day'::interval
                    )::date AS day
                ),
                daily AS (
                    SELECT
                        created_at::date AS day,
                        COUNT(*) FILTER (WHERE action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR')) AS executions,
                        COUNT(*) FILTER (WHERE action = 'POLICY_VIOLATION') AS violations
                    FROM audit_logs_partitioned
                    WHERE org_id = $1 AND created_at >= CURRENT_DATE - ($2 || ' days')::interval
                    GROUP BY created_at::date
                )
                SELECT
                    ds.day,
                    COALESCE(d.executions, 0) AS executions,
                    COALESCE(d.violations, 0) AS violations
                FROM date_series ds
                LEFT JOIN daily d ON ds.day = d.day
                ORDER BY ds.day
            `, [orgId, days]);

            // Latency P95 per day — only days with data (no zero-fill for latency)
            const latencyTrend = await client.query(`
                SELECT
                    created_at::date AS day,
                    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
                        ORDER BY (metadata->>'latency_ms')::numeric
                    )::numeric, 0) AS p95_ms
                FROM audit_logs_partitioned
                WHERE org_id = $1
                    AND created_at >= CURRENT_DATE - ($2 || ' days')::interval
                    AND action = 'EXECUTION_SUCCESS'
                    AND metadata->>'latency_ms' IS NOT NULL
                GROUP BY created_at::date
                ORDER BY day
            `, [orgId, days]);

            return {
                executions: execTrend.rows.map(r => ({
                    day: r.day,
                    count: parseInt(r.executions) || 0,
                })),
                violations: execTrend.rows.map(r => ({
                    day: r.day,
                    count: parseInt(r.violations) || 0,
                })),
                latency: latencyTrend.rows.map(r => ({
                    day: r.day,
                    p95_ms: parseInt(r.p95_ms) || 0,
                })),
            };
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/monitoring/alerts ───────────────────────────────────
    // Returns active threshold alerts as a flat array.
    // Response shape matches the frontend AlertItem[] interface.
    app.get('/v1/admin/monitoring/alerts', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const orgRow = await client.query(
                'SELECT alert_thresholds FROM organizations WHERE id = $1',
                [orgId]
            );
            const defaults = { latency_p95_ms: 5000, violation_rate_pct: 10, daily_cost_usd: 50 };
            const thresholds = { ...defaults, ...(orgRow.rows[0]?.alert_thresholds || {}) };

            const alerts: Array<{
                severity: 'critical' | 'warning';
                type: string;
                message: string;
                value: number;
                threshold: number;
            }> = [];

            // 1. Latency P95 per assistant (last 24h, min 3 samples)
            const latencyCheck = await client.query(`
                SELECT
                    a.name AS assistant_name,
                    PERCENTILE_CONT(0.95) WITHIN GROUP (
                        ORDER BY (al.metadata->>'latency_ms')::numeric
                    ) AS latency_p95
                FROM audit_logs_partitioned al
                LEFT JOIN assistants a ON al.assistant_id = a.id
                WHERE al.org_id = $1
                    AND al.created_at >= NOW() - INTERVAL '24 hours'
                    AND al.action = 'EXECUTION_SUCCESS'
                    AND al.metadata->>'latency_ms' IS NOT NULL
                GROUP BY al.assistant_id, a.name
                HAVING COUNT(*) >= 3
            `, [orgId]);

            for (const r of latencyCheck.rows) {
                const p95 = Math.round(parseFloat(r.latency_p95) || 0);
                if (p95 > thresholds.latency_p95_ms) {
                    alerts.push({
                        severity: p95 > thresholds.latency_p95_ms * 2 ? 'critical' : 'warning',
                        type: 'latency_p95',
                        message: `${r.assistant_name || 'Assistente'}: latência P95 = ${p95} ms (limite: ${thresholds.latency_p95_ms} ms)`,
                        value: p95,
                        threshold: thresholds.latency_p95_ms,
                    });
                }
            }

            // 2. Violation rate per assistant (last 24h, min 3 executions)
            const violationCheck = await client.query(`
                SELECT
                    a.name AS assistant_name,
                    COUNT(*) FILTER (WHERE al.action = 'POLICY_VIOLATION') AS violations,
                    COUNT(*) FILTER (WHERE al.action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'POLICY_VIOLATION')) AS total,
                    ROUND(
                        100.0 * COUNT(*) FILTER (WHERE al.action = 'POLICY_VIOLATION') /
                        NULLIF(COUNT(*) FILTER (WHERE al.action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'POLICY_VIOLATION')), 0),
                        1
                    ) AS violation_rate
                FROM audit_logs_partitioned al
                LEFT JOIN assistants a ON al.assistant_id = a.id
                WHERE al.org_id = $1
                    AND al.created_at >= NOW() - INTERVAL '24 hours'
                    AND al.action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'POLICY_VIOLATION')
                GROUP BY al.assistant_id, a.name
                HAVING COUNT(*) >= 3
            `, [orgId]);

            for (const r of violationCheck.rows) {
                const rate = parseFloat(r.violation_rate) || 0;
                if (rate > thresholds.violation_rate_pct) {
                    alerts.push({
                        severity: rate > thresholds.violation_rate_pct * 2 ? 'critical' : 'warning',
                        type: 'violation_rate',
                        message: `${r.assistant_name || 'Assistente'}: taxa de violação = ${rate}% (limite: ${thresholds.violation_rate_pct}%)`,
                        value: rate,
                        threshold: thresholds.violation_rate_pct,
                    });
                }
            }

            // 3. Daily cost threshold (today's total)
            const costCheck = await client.query(`
                SELECT COALESCE(SUM((metadata->>'cost')::numeric), 0) AS daily_cost
                FROM audit_logs_partitioned
                WHERE org_id = $1 AND created_at >= CURRENT_DATE
                    AND metadata->>'cost' IS NOT NULL
            `, [orgId]);

            const dailyCost = parseFloat(costCheck.rows[0].daily_cost) || 0;
            if (dailyCost > thresholds.daily_cost_usd) {
                alerts.push({
                    severity: dailyCost > thresholds.daily_cost_usd * 2 ? 'critical' : 'warning',
                    type: 'daily_cost',
                    message: `Custo diário: $${dailyCost.toFixed(2)} (limite: $${thresholds.daily_cost_usd})`,
                    value: Math.round(dailyCost * 100) / 100,
                    threshold: thresholds.daily_cost_usd,
                });
            }

            // Sort: critical first
            alerts.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1));

            return alerts;
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/monitoring/thresholds ──────────────────────────────
    app.get('/v1/admin/monitoring/thresholds', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                'SELECT alert_thresholds FROM organizations WHERE id = $1',
                [orgId]
            );
            const defaults = { latency_p95_ms: 5000, violation_rate_pct: 10, daily_cost_usd: 50 };
            return { ...defaults, ...(result.rows[0]?.alert_thresholds || {}) };
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/monitoring/thresholds ──────────────────────────────
    app.put('/v1/admin/monitoring/thresholds', { preHandler: authAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const body = request.body as { latency_p95_ms?: number; violation_rate_pct?: number; daily_cost_usd?: number };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const existing = await client.query(
                'SELECT alert_thresholds FROM organizations WHERE id = $1',
                [orgId]
            );
            const current = existing.rows[0]?.alert_thresholds || {};
            const merged = { ...current, ...body };
            await client.query(
                'UPDATE organizations SET alert_thresholds = $1 WHERE id = $2',
                [JSON.stringify(merged), orgId]
            );
            return merged;
        } finally {
            client.release();
        }
    });
}
