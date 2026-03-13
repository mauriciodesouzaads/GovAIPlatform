import { describe, it, expect, beforeEach } from 'vitest';
import {
    httpRequestsTotal,
    dlpDetectionsTotal,
    quotaExceededTotal,
    activePgConnections,
    redisQueueDepth,
    resetMetricsForTesting,
    recordRequest,
    recordDlpDetection,
    recordQuotaExceeded,
    renderPrometheusMetrics,
} from '../lib/sre-metrics';

describe('Observability & Metrics Baseline', () => {
    beforeEach(() => {
        resetMetricsForTesting();
    });

    it('should record requests with correct labels and latency histogram', async () => {
        recordRequest('success', 100);
        recordRequest('success', 200);
        recordRequest('blocked', 50);

        const result = await httpRequestsTotal.get();
        const byLabel = (label: string) =>
            result.values.find(v => v.labels.status === label)?.value ?? 0;

        expect(byLabel('success')).toBe(2);
        expect(byLabel('blocked')).toBe(1);
    });

    it('should record DLP detections', async () => {
        recordDlpDetection(5);
        recordDlpDetection(2);

        const result = await dlpDetectionsTotal.get();
        expect(result.values[0]?.value).toBe(7);
    });

    it('should record quota exceeded events', async () => {
        recordQuotaExceeded();
        recordQuotaExceeded();

        const result = await quotaExceededTotal.get();
        expect(result.values[0]?.value).toBe(2);
    });

    it('should correctly render Prometheus exposition format', async () => {
        recordRequest('success', 150);
        recordQuotaExceeded();

        const output = await renderPrometheusMetrics();

        expect(output).toContain('# HELP govai_http_requests_total');
        expect(output).toContain('# TYPE govai_http_requests_total counter');
        expect(output).toContain('govai_http_requests_total');
        expect(output).toContain('govai_quota_exceeded_total');
        expect(output).toContain('govai_gateway_latency_ms');
        expect(output).toContain('govai_dlp_detections_total');
        expect(output).toContain('govai_active_pg_connections');
    });
});
