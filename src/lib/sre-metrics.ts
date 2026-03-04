/**
 * SRE Observability — Prometheus Metrics Endpoint
 * 
 * Exposes /metrics in Prometheus text format for Grafana/Datadog scraping.
 * Tracks: gateway latency, request counts, Redis queue depth, PG pool stats.
 */

export interface MetricsBucket {
    http_requests_total: number;
    http_requests_blocked: number;
    http_requests_approved: number;
    gateway_latency_ms_sum: number;
    gateway_latency_ms_count: number;
    dlp_detections_total: number;
    quota_exceeded_total: number;
    active_pg_connections: number;
    redis_queue_depth: number;
}

// Global in-memory metrics store (production would use prom-client)
export const metrics: MetricsBucket = {
    http_requests_total: 0,
    http_requests_blocked: 0,
    http_requests_approved: 0,
    gateway_latency_ms_sum: 0,
    gateway_latency_ms_count: 0,
    dlp_detections_total: 0,
    quota_exceeded_total: 0,
    active_pg_connections: 0,
    redis_queue_depth: 0,
};

export function recordRequest(type: 'success' | 'blocked' | 'approved', latencyMs: number) {
    metrics.http_requests_total++;
    metrics.gateway_latency_ms_sum += latencyMs;
    metrics.gateway_latency_ms_count++;
    if (type === 'blocked') metrics.http_requests_blocked++;
    if (type === 'approved') metrics.http_requests_approved++;
}

export function recordDlpDetection(count: number) {
    metrics.dlp_detections_total += count;
}

export function recordQuotaExceeded() {
    metrics.quota_exceeded_total++;
}

/**
 * Renders metrics in Prometheus text exposition format.
 */
export function renderPrometheusMetrics(): string {
    const avgLatency = metrics.gateway_latency_ms_count > 0
        ? (metrics.gateway_latency_ms_sum / metrics.gateway_latency_ms_count).toFixed(2)
        : '0';

    return [
        '# HELP govai_http_requests_total Total HTTP requests processed',
        '# TYPE govai_http_requests_total counter',
        `govai_http_requests_total ${metrics.http_requests_total}`,
        '',
        '# HELP govai_http_requests_blocked Total requests blocked by OPA/DLP',
        '# TYPE govai_http_requests_blocked counter',
        `govai_http_requests_blocked ${metrics.http_requests_blocked}`,
        '',
        '# HELP govai_http_requests_approved Total HITL approvals granted',
        '# TYPE govai_http_requests_approved counter',
        `govai_http_requests_approved ${metrics.http_requests_approved}`,
        '',
        '# HELP govai_gateway_latency_ms_avg Average gateway response latency in ms',
        '# TYPE govai_gateway_latency_ms_avg gauge',
        `govai_gateway_latency_ms_avg ${avgLatency}`,
        '',
        '# HELP govai_dlp_detections_total Total PII detections by DLP engine',
        '# TYPE govai_dlp_detections_total counter',
        `govai_dlp_detections_total ${metrics.dlp_detections_total}`,
        '',
        '# HELP govai_quota_exceeded_total Total quota exceeded events',
        '# TYPE govai_quota_exceeded_total counter',
        `govai_quota_exceeded_total ${metrics.quota_exceeded_total}`,
        '',
        '# HELP govai_active_pg_connections Active PostgreSQL connections',
        '# TYPE govai_active_pg_connections gauge',
        `govai_active_pg_connections ${metrics.active_pg_connections}`,
        '',
        '# HELP govai_redis_queue_depth Current BullMQ/Redis queue depth',
        '# TYPE govai_redis_queue_depth gauge',
        `govai_redis_queue_depth ${metrics.redis_queue_depth}`,
        '',
    ].join('\n');
}
