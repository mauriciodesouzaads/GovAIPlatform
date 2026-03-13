/**
 * SRE Observability — Prometheus Metrics with prom-client.
 *
 * Replaces the previous in-memory counter store with proper prom-client primitives:
 * - Histograms for latency (correct p50/p95/p99 quantiles instead of simple averages)
 * - collectDefaultMetrics for Node.js runtime telemetry (GC, event-loop lag, memory)
 * - Registry-scoped metrics to avoid conflicts in multi-tenant tests
 *
 * For multi-replica aggregation, configure Prometheus to scrape all pod /metrics
 * endpoints (standard pull model) or use a Pushgateway for batch workers.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// ── Per-assistant latency (labeled histogram) ─────────────────────────────────
// NOTA DE CARDINALIDADE: o label assistant_id é um UUID. Em clusters com centenas
// de assistentes, cada série ocupa ~1KB de memória no Prometheus. Para plataformas
// com >500 assistentes, considere agregar por tenant em vez de por assistente.

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: 'govai_node_' });

export const httpRequestsTotal = new Counter({
    name: 'govai_http_requests_total',
    help: 'Total HTTP requests processed by the governance gateway',
    labelNames: ['status'] as const,
    registers: [metricsRegistry],
});

export const dlpDetectionsTotal = new Counter({
    name: 'govai_dlp_detections_total',
    help: 'Total PII detections flagged by the DLP engine',
    registers: [metricsRegistry],
});

export const quotaExceededTotal = new Counter({
    name: 'govai_quota_exceeded_total',
    help: 'Total quota exceeded events (hard-cap enforcement)',
    registers: [metricsRegistry],
});

export const gatewayLatencyHistogram = new Histogram({
    name: 'govai_gateway_latency_ms',
    help: 'End-to-end gateway latency in milliseconds (p50/p95/p99)',
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [metricsRegistry],
});

export const activePgConnections = new Gauge({
    name: 'govai_active_pg_connections',
    help: 'Active PostgreSQL client connections from the shared pool',
    registers: [metricsRegistry],
});

export const redisQueueDepth = new Gauge({
    name: 'govai_redis_queue_depth',
    help: 'Current BullMQ audit-log queue depth',
    registers: [metricsRegistry],
});

export const telemetryQueueDepth = new Gauge({
    name: 'govai_telemetry_queue_depth',
    help: 'Current BullMQ telemetry queue depth (Langfuse export backlog)',
    registers: [metricsRegistry],
});

// LGPD compliance tracking — updated every 5 minutes by server.ts
export const complianceConsentedOrgs = new Gauge({
    name: 'govai_compliance_consented_orgs',
    help: 'Number of organizations with telemetry_consent = TRUE (LGPD Art. 7, I)',
    registers: [metricsRegistry],
});

// Per-assistant latency histogram — labeled by assistant_id for P95/P99 drill-down
export const assistantLatencyHistogram = new Histogram({
    name: 'govai_assistant_latency_ms',
    help: 'End-to-end execution latency per assistant (ms) — enables P95/P99 per-assistant drill-down',
    labelNames: ['assistant_id'] as const,
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
    registers: [metricsRegistry],
});

// Key rotation metrics — tracked by the key rotation scheduler
export const dekRotationsTotal = new Counter({
    name: 'govai_dek_rotations_total',
    help: 'Total number of DEKs successfully rotated by the key rotation scheduler',
    registers: [metricsRegistry],
});

export const dekRotationErrorsTotal = new Counter({
    name: 'govai_dek_rotation_errors_total',
    help: 'Total DEK rotation failures (row skipped, will be retried next cycle)',
    registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Compatibility helpers — same call-sites as the previous implementation
// ---------------------------------------------------------------------------

export function recordRequest(type: 'success' | 'blocked' | 'approved', latencyMs: number): void {
    httpRequestsTotal.inc({ status: type });
    gatewayLatencyHistogram.observe(latencyMs);
}

export function recordDlpDetection(count: number): void {
    dlpDetectionsTotal.inc(count);
}

export function recordQuotaExceeded(): void {
    quotaExceededTotal.inc();
}

export function updateComplianceConsentedOrgs(count: number): void {
    complianceConsentedOrgs.set(count);
}

export async function renderPrometheusMetrics(): Promise<string> {
    return metricsRegistry.metrics();
}

export function getMetricsContentType(): string {
    return metricsRegistry.contentType;
}

/**
 * Resets all metric values to zero.
 * Intended for use in test suites only — do not call in production code.
 */
export function resetMetricsForTesting(): void {
    metricsRegistry.resetMetrics();
}
