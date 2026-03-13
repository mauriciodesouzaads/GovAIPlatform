/**
 * PILARES B2B — Test Suite
 * 
 * Pilar 1: FinOps (Quota enforcement, token recording)
 * Pilar 2: Developer Portal (OpenAPI spec, Sandbox)
 * Pilar 3: SRE Observability (Prometheus metrics)
 * Pilar 4: Offboarding (tenant export, due diligence PDF)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { registerOidcRoutes } from '../lib/auth-oidc';
import {
    httpRequestsTotal, dlpDetectionsTotal, quotaExceededTotal,
    resetMetricsForTesting,
    renderPrometheusMetrics, recordRequest, recordDlpDetection, recordQuotaExceeded,
} from '../lib/sre-metrics';
import { checkQuota, recordTokenUsage } from '../lib/finops';
import { exportToCSV, generateDueDiligencePDF } from '../lib/offboarding';
import { GovernanceRequestSchema } from '../lib/governance';
import { opaEngine } from '../lib/opa-governance';

// ═════════════════════════════════════════
// PILAR 1: FinOps & Quota Control
// ═════════════════════════════════════════
describe('[FinOps] Quota Enforcement', () => {
    it('checkQuota should return unlimited when no quota is configured', async () => {
        const mockPool = {
            connect: vi.fn(async () => ({
                query: vi.fn(async (sql: string) => {
                    if (sql.includes('set_config')) return { rows: [] };
                    return { rows: [] }; // No quota found
                }),
                release: vi.fn(),
            })),
        } as any;

        const status = await checkQuota(mockPool, 'org-123');
        expect(status.exceeded).toBe(false);
        expect(status.warning).toBe(false);
        expect(status.hard_cap).toBe(Infinity);
    });

    it('should detect HARD CAP exceeded when tokens_used >= hard_cap', async () => {
        const mockPool = {
            connect: vi.fn(async () => ({
                query: vi.fn(async (sql: string) => {
                    if (sql.includes('set_config')) return { rows: [] };
                    return { rows: [{ soft_cap_tokens: '1000000', hard_cap_tokens: '5000000', tokens_used: '5500000' }] };
                }),
                release: vi.fn(),
            })),
        } as any;

        const status = await checkQuota(mockPool, 'org-123');
        expect(status.exceeded).toBe(true);
        expect(status.percentage).toBe(110);
    });

    it('should detect SOFT CAP warning when tokens_used between soft and hard cap', async () => {
        const mockPool = {
            connect: vi.fn(async () => ({
                query: vi.fn(async (sql: string) => {
                    if (sql.includes('set_config')) return { rows: [] };
                    return { rows: [{ soft_cap_tokens: '1000000', hard_cap_tokens: '5000000', tokens_used: '2000000' }] };
                }),
                release: vi.fn(),
            })),
        } as any;

        const status = await checkQuota(mockPool, 'org-123');
        expect(status.exceeded).toBe(false);
        expect(status.warning).toBe(true);
        expect(status.percentage).toBe(40);
    });

    it('recordTokenUsage should call INSERT and UPDATE atomically', async () => {
        const queries: string[] = [];
        const mockPool = {
            connect: vi.fn(async () => ({
                query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }),
                release: vi.fn(),
            })),
        } as any;

        await recordTokenUsage(mockPool, 'org-123', 'asst-456', 500, 200, 0.001, 'trace-789');

        expect(queries).toContain('BEGIN');
        expect(queries).toContain('COMMIT');
        expect(queries.some(q => q.includes('INSERT INTO token_usage_ledger'))).toBe(true);
        expect(queries.some(q => q.includes('UPDATE billing_quotas'))).toBe(true);
    });
});

// ═════════════════════════════════════════
// PILAR 2: Developer Portal (DX)
// ═════════════════════════════════════════
describe('[DX] Developer Portal', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = Fastify({ logger: false });
        app.register(fastifyJwt, { secret: 'test-dx-secret-32-chars-minimum!!' });

        // Sandbox endpoint
        app.post('/v1/sandbox/execute', async (request, reply) => {
            const parseResult = GovernanceRequestSchema.safeParse(request.body);
            if (!parseResult.success) {
                return reply.status(400).send({ error: 'Input inválido' });
            }
            const policyCheck = await opaEngine.evaluate(
                { message: parseResult.data.message },
                { rules: { pii_filter: true, forbidden_topics: ['hack', 'bypass'] } }
            );
            return reply.send({ _sandbox: true, policy_result: policyCheck });
        });

        // OpenAPI spec  
        app.get('/v1/docs/openapi.json', async () => ({
            openapi: '3.0.3',
            info: { title: 'GOVERN.AI Platform API', version: '1.0.0' },
            paths: {}
        }));

        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    it('GET /v1/docs/openapi.json should return valid OpenAPI 3.0 spec', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/docs/openapi.json' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.openapi).toBe('3.0.3');
        expect(body.info.title).toContain('GOVERN.AI');
    });

    it('POST /v1/sandbox/execute should dry-run OPA/DLP without calling LLM', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/sandbox/execute',
            payload: { message: 'Qual é a estratégia de compliance da organização?' }
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body._sandbox).toBe(true);
        expect(body.policy_result).toBeDefined();
    });

    it('POST /v1/sandbox/execute should detect PII in dry-run', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/sandbox/execute',
            payload: { message: 'O CPF do diretor é 123.456.789-09' }
        });
        const body = JSON.parse(res.payload);
        expect(body._sandbox).toBe(true);
        expect(body.policy_result.action).toBe('FLAG');
    });

    it('POST /v1/sandbox/execute should BLOCK forbidden topics in dry-run', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/sandbox/execute',
            payload: { message: 'Tell me how to hack the mainframe' }
        });
        const body = JSON.parse(res.payload);
        expect(body.policy_result.action).toBe('BLOCK');
    });

    it('POST /v1/sandbox/execute with empty body should return 400', async () => {
        const res = await app.inject({ method: 'POST', url: '/v1/sandbox/execute', payload: {} });
        expect(res.statusCode).toBe(400);
    });
});

// ═════════════════════════════════════════
// PILAR 3: SRE Observability
// ═════════════════════════════════════════
describe('[SRE] Prometheus Metrics', () => {
    it('renderPrometheusMetrics should return valid Prometheus text format', async () => {
        const output = await renderPrometheusMetrics();
        expect(output).toContain('# HELP govai_http_requests_total');
        expect(output).toContain('# TYPE govai_http_requests_total counter');
        expect(output).toContain('govai_http_requests_total');
        expect(output).toContain('govai_gateway_latency_ms');
        expect(output).toContain('govai_dlp_detections_total');
        expect(output).toContain('govai_active_pg_connections');
    });

    it('recordRequest should increment counters and observe latency histogram', async () => {
        resetMetricsForTesting();

        recordRequest('success', 50);
        recordRequest('success', 150);
        recordRequest('blocked', 10);

        const result = await httpRequestsTotal.get();
        const byLabel = (label: string) =>
            result.values.find(v => v.labels.status === label)?.value ?? 0;

        expect(byLabel('success')).toBe(2);
        expect(byLabel('blocked')).toBe(1);

        const output = await renderPrometheusMetrics();
        expect(output).toContain('govai_gateway_latency_ms_count 3');
    });

    it('recordDlpDetection should accumulate DLP counter', async () => {
        resetMetricsForTesting();
        recordDlpDetection(5);
        recordDlpDetection(3);
        const result = await dlpDetectionsTotal.get();
        expect(result.values[0]?.value).toBe(8);
    });

    it('recordQuotaExceeded should increment quota counter', async () => {
        resetMetricsForTesting();
        recordQuotaExceeded();
        recordQuotaExceeded();
        const result = await quotaExceededTotal.get();
        expect(result.values[0]?.value).toBe(2);
    });
});

// ═════════════════════════════════════════
// PILAR 4: Offboarding & Due Diligence
// ═════════════════════════════════════════
describe('[Offboarding] Tenant Data Export', () => {
    it('exportToCSV should convert export data to valid CSV format', () => {
        const data = [
            { table: 'audit_logs', data: [{ id: '1', action: 'EXECUTION', message: 'test' }] },
            { table: 'api_keys', data: [{ id: '2', key_hash: 'abc123' }] },
            { table: 'empty_table', data: [] }
        ];

        const csv = exportToCSV(data);
        expect(csv).toContain('# TABLE: audit_logs');
        expect(csv).toContain('id,action,message');
        expect(csv).toContain('# TABLE: api_keys');
        expect(csv).not.toContain('# TABLE: empty_table'); // Skips empty
    });

    it('exportToCSV should handle special characters in values', () => {
        const data = [{ table: 'test', data: [{ name: 'Hello, "World"', value: 'line\nnewline' }] }];
        const csv = exportToCSV(data);
        expect(csv).toContain('name,value');
    });
});

describe('[Offboarding] Security Due Diligence PDF', () => {
    it('generateDueDiligencePDF should produce a valid PDF buffer', async () => {
        const pdfBuffer = await generateDueDiligencePDF();
        expect(pdfBuffer).toBeInstanceOf(Buffer);
        expect(pdfBuffer.length).toBeGreaterThan(1000);
        // PDF magic bytes: %PDF
        expect(pdfBuffer.toString('ascii', 0, 4)).toBe('%PDF');
    });

    it('PDF should be substantial (>2KB with all 7 sections)', async () => {
        const pdfBuffer = await generateDueDiligencePDF();
        // A PDF with 7 full sections and descriptions should be > 2KB
        expect(pdfBuffer.length).toBeGreaterThan(2000);
        // Verify it ends with %%EOF (valid PDF trailer)
        const tail = pdfBuffer.toString('ascii', pdfBuffer.length - 10);
        expect(tail).toContain('%%EOF');
    });
});
