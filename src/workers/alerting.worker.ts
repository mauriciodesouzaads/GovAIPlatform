/**
 * Alerting Worker — FASE 10
 * ---------------------------------------------------------------------------
 * Evaluates alert thresholds (organizations.alert_thresholds JSONB column,
 * migration 070) every 60s and enqueues notifications to the existing
 * notification_channels pipeline when a threshold is breached. Reuses the
 * notification.worker infrastructure (Slack, Teams, Email) so operators
 * don't need AlertManager for basic in-app alerting.
 *
 * Threshold shape (per org, stored in organizations.alert_thresholds):
 *   {
 *     "latency_p95_ms": 5000,       // alert when gateway p95 > 5s
 *     "violation_rate_pct": 10,     // alert when >10% requests blocked
 *     "daily_cost_usd": 50          // (not evaluated here — see finops)
 *   }
 *
 * Prometheus AlertManager rules (deploy/prometheus/alerts.yaml) provide
 * a second, infrastructure-level alerting path for teams that already
 * run Prometheus.
 */

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Pool, PoolClient } from 'pg';
import { logEvent } from '../lib/structured-log';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const alertingQueue = new Queue('alerting', {
    connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any,
    defaultJobOptions: {
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 10 },
    },
});

export function initAlertingWorker(pgPool: Pool) {
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any;

    const worker = new Worker(
        'alerting',
        async () => {
            try {
                await evaluateAllOrgs(pgPool);
            } catch (err) {
                console.error('[Alerting] evaluation tick failed:', (err as Error).message);
            }
        },
        { connection, concurrency: 1 }
    );

    // Schedule repeatable evaluation every 60 seconds.
    // jobId makes it idempotent — calling add() again is a no-op.
    alertingQueue.add('evaluate', {}, {
        repeat: { every: 60_000 },
        jobId: 'alert-evaluation-tick',
    }).catch((err) => {
        console.warn('[Alerting] failed to schedule repeatable job:', (err as Error).message);
    });

    worker.on('failed', (job, err) => {
        console.error(`[Alerting] Job ${job?.id} failed: ${err?.message}`);
    });

    console.log('[Alerting Worker] Started (60s evaluation cycle)');
    return worker;
}

async function evaluateAllOrgs(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        // Read thresholds directly from organizations.alert_thresholds
        // (JSONB column, migration 070). Default values are inherited via
        // the column default so every org has something to evaluate.
        const orgs = await client.query(
            `SELECT id, alert_thresholds FROM organizations
             WHERE alert_thresholds IS NOT NULL`
        );

        for (const { id: orgId, alert_thresholds: thresholds } of orgs.rows) {
            await evaluateOrgThresholds(client, orgId, thresholds ?? {});
        }
    } finally {
        client.release();
    }
}

interface OrgThresholds {
    latency_p95_ms?: number;
    violation_rate_pct?: number;
    daily_cost_usd?: number;
}

async function evaluateOrgThresholds(
    client: PoolClient,
    orgId: string,
    thresholds: OrgThresholds
): Promise<void> {
    // Window: 15 minutes for latency/violation rate. Long enough to be
    // statistically meaningful, short enough to catch real incidents.
    const windowMinutes = 15;
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // Evaluate each defined threshold
        const checks: Array<{ metric: string; value: number; threshold: number; op: string }> = [];

        if (typeof thresholds.latency_p95_ms === 'number') {
            const v = await evaluateMetric(client, orgId, 'gateway_latency_p95', windowMinutes);
            if (v !== null) checks.push({ metric: 'latency_p95_ms', value: v, threshold: thresholds.latency_p95_ms, op: '>' });
        }
        if (typeof thresholds.violation_rate_pct === 'number') {
            const v = await evaluateMetric(client, orgId, 'violation_rate_pct', windowMinutes);
            if (v !== null) checks.push({ metric: 'violation_rate_pct', value: v, threshold: thresholds.violation_rate_pct, op: '>' });
        }

        for (const c of checks) {
            if (compareOp(c.value, c.op, c.threshold)) {
                // Enqueue notification via the existing pipeline
                try {
                    const { notificationQueue } = await import('./notification.worker');
                    await notificationQueue.add('alert', {
                        event: `alert.${c.metric}`,
                        orgId,
                        timestamp: new Date().toISOString(),
                        metadata: {
                            metric: c.metric,
                            threshold: c.threshold,
                            actual: c.value,
                            window_minutes: windowMinutes,
                        },
                    });
                } catch {
                    // notification queue unavailable — log only
                }

                logEvent({
                    component: 'alerting',
                    outcome: 'pending',
                    org_id: orgId,
                    metric: c.metric,
                    threshold: c.threshold,
                    actual: c.value,
                }, `Alert threshold breached: ${c.metric} ${c.op} ${c.threshold} (actual: ${c.value})`);
            }
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
    }
}

/**
 * Evaluate a single metric from the database. Returns the current value
 * or null if the metric isn't measurable (unknown metric name, no data).
 */
async function evaluateMetric(
    client: PoolClient,
    orgId: string,
    metric: string,
    windowMinutes: number
): Promise<number | null> {
    const windowClause = `NOW() - INTERVAL '${Math.max(1, Math.floor(windowMinutes))} minutes'`;

    try {
        switch (metric) {
            case 'gateway_latency_p95':
            case 'high_latency': {
                const r = await client.query(
                    `SELECT EXTRACT(EPOCH FROM (MAX(al.created_at) - MIN(al.created_at))) * 1000 AS p95
                     FROM (
                         SELECT created_at
                         FROM audit_logs_partitioned
                         WHERE org_id = $1 AND created_at > ${windowClause}
                         ORDER BY created_at
                         LIMIT 100
                     ) al`,
                    [orgId]
                );
                return parseFloat(r.rows[0]?.p95 ?? '0');
            }

            case 'violation_rate':
            case 'high_violation': {
                const r = await client.query(
                    `SELECT COUNT(*)::float / GREATEST(EXTRACT(EPOCH FROM (NOW() - ${windowClause})) / 60, 1) AS rate
                     FROM audit_logs_partitioned
                     WHERE org_id = $1 AND action = 'POLICY_VIOLATION'
                       AND created_at > ${windowClause}`,
                    [orgId]
                );
                return parseFloat(r.rows[0]?.rate ?? '0');
            }

            case 'violation_rate_pct': {
                // Percentage of POLICY_VIOLATION events vs total execution events
                const r = await client.query(
                    `SELECT
                        COUNT(*) FILTER (WHERE action = 'POLICY_VIOLATION')::float
                            / GREATEST(COUNT(*) FILTER (WHERE action IN (
                                'POLICY_VIOLATION', 'EXECUTION_SUCCESS', 'EXECUTION_ERROR'
                            )), 1) * 100 AS pct
                     FROM audit_logs_partitioned
                     WHERE org_id = $1 AND created_at > ${windowClause}`,
                    [orgId]
                );
                return parseFloat(r.rows[0]?.pct ?? '0');
            }

            case 'execution_count': {
                const r = await client.query(
                    `SELECT COUNT(*)::int AS count
                     FROM audit_logs_partitioned
                     WHERE org_id = $1 AND action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR')
                       AND created_at > ${windowClause}`,
                    [orgId]
                );
                return parseInt(r.rows[0]?.count ?? '0', 10);
            }

            default:
                return null;
        }
    } catch {
        return null;
    }
}

function compareOp(actual: number, op: string, threshold: number): boolean {
    switch (op) {
        case '>': return actual > threshold;
        case '>=': return actual >= threshold;
        case '<': return actual < threshold;
        case '<=': return actual <= threshold;
        case '==': return actual === threshold;
        default: return false;
    }
}
