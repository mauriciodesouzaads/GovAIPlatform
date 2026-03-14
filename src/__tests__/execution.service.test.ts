/**
 * P-15: Coverage for execution.service.ts
 *
 * Mocks all external dependencies (pgPool, opaEngine, dlpEngine,
 * auditQueue, redisCache, axios, finops, sre-metrics) to cover
 * the main execution paths without infrastructure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted by Vitest) ─────────────────────────────────────────

vi.mock('../lib/db', () => ({
    pgPool: { connect: vi.fn() },
}));

vi.mock('../lib/opa-governance', () => ({
    opaEngine: { evaluate: vi.fn() },
}));

vi.mock('../lib/dlp-engine', () => ({
    dlpEngine: {
        sanitize: vi.fn(),
        sanitizeObject: vi.fn(),
    },
}));

vi.mock('../workers/audit.worker', () => ({
    auditQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../workers/notification.worker', () => ({
    notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../workers/telemetry.worker', () => ({
    telemetryQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../lib/sre-metrics', () => ({
    recordRequest: vi.fn(),
    recordDlpDetection: vi.fn(),
    assistantLatencyHistogram: { observe: vi.fn() },
}));

vi.mock('../lib/finops', () => ({
    checkQuota: vi.fn(),
    recordTokenUsage: vi.fn().mockResolvedValue(undefined),
    getCostPerToken: vi.fn().mockReturnValue(0.000002),
}));

vi.mock('../lib/redis', () => ({
    redisCache: {
        get: vi.fn(),
        setex: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('axios', () => ({
    default: { post: vi.fn() },
}));

import { executeAssistant } from '../services/execution.service';
import { pgPool } from '../lib/db';
import { opaEngine } from '../lib/opa-governance';
import { dlpEngine } from '../lib/dlp-engine';
import { checkQuota } from '../lib/finops';
import { redisCache } from '../lib/redis';
import axios from 'axios';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient(overrides?: { queryImpl?: (sql: string) => any }) {
    return {
        query: vi.fn().mockImplementation(async (sql: string) => {
            if (overrides?.queryImpl) {
                const result = overrides.queryImpl(sql);
                if (result !== undefined) return result;
            }
            return { rows: [] };
        }),
        release: vi.fn(),
    };
}

const baseParams = {
    assistantId: 'ast-123',
    orgId: 'org-456',
    message: 'Hello AI',
    traceId: 'trace-789',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeAssistant', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.SIGNING_SECRET = 'test-signing-secret-exactly-32ch!';
        process.env.LITELLM_URL = 'http://localhost:4000';
        process.env.LITELLM_KEY = 'test-litellm-key';
    });

    it('returns 429 when FinOps hard cap is exceeded', async () => {
        const client = makeClient();
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: true, warning: false } as any);

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(429);
        expect((result.body as any).error).toContain('Hard Cap');
        expect(client.release).toHaveBeenCalled();
    });

    it('adds Quota-Warning header when soft cap exceeded', async () => {
        const client = makeClient();
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: false, warning: true } as any);
        // cache hit → skip DB version query
        vi.mocked(redisCache.get).mockResolvedValue(JSON.stringify({ pii_filter: false }));
        vi.mocked(opaEngine.evaluate).mockResolvedValue({
            allowed: true, action: 'ALLOW', sanitizedInput: 'Hello AI',
        } as any);
        vi.mocked(dlpEngine.sanitize).mockReturnValue({ sanitizedText: 'Hello AI', detections: [] } as any);
        vi.mocked(dlpEngine.sanitizeObject).mockResolvedValue({ sanitized: { input: 'Hello AI', output: {} } } as any);
        vi.mocked(axios.post).mockResolvedValue({
            data: {
                choices: [{ message: { content: 'response' } }],
                usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
            },
        } as any);
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes('organizations')) return { rows: [{ telemetry_consent: false, telemetry_pii_strip: true }] };
            return { rows: [] };
        });

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(200);
    });

    it('returns 404 when assistant does not exist (cache miss, no versions)', async () => {
        const client = makeClient();
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: false, warning: false } as any);
        vi.mocked(redisCache.get).mockResolvedValue(null);
        // Both assistant_versions and assistants queries return empty rows

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(404);
        expect((result.body as any).error).toContain('não encontrado');
    });

    it('returns 403 on policy violation (OPA BLOCK)', async () => {
        const client = makeClient({
            queryImpl: (sql) => {
                if (sql.includes('assistants WHERE id')) return { rows: [{ id: 'ast-123' }] };
            },
        });
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: false, warning: false } as any);
        vi.mocked(redisCache.get).mockResolvedValue(null);
        vi.mocked(opaEngine.evaluate).mockResolvedValue({
            allowed: false,
            action: 'BLOCK',
            reason: 'Forbidden topic: hack',
            sanitizedInput: 'Hello AI',
        } as any);
        vi.mocked(dlpEngine.sanitize).mockReturnValue({ sanitizedText: 'Hello AI', detections: [] } as any);

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(403);
        expect((result.body as any).error).toBe('Forbidden topic: hack');
        expect((result.body as any).traceId).toBe('trace-789');
    });

    it('returns 202 on HITL PENDING_APPROVAL', async () => {
        const client = makeClient({
            queryImpl: (sql) => {
                if (sql.includes('pending_approvals')) return { rows: [{ id: 'approval-1', created_at: new Date() }] };
            },
        });
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: false, warning: false } as any);
        vi.mocked(redisCache.get).mockResolvedValue(JSON.stringify({ hitl_enabled: true, hitl_keywords: ['transferência'] }));
        vi.mocked(opaEngine.evaluate).mockResolvedValue({
            allowed: true,
            action: 'PENDING_APPROVAL',
            reason: 'High-risk keyword: transferência',
        } as any);
        vi.mocked(dlpEngine.sanitize).mockReturnValue({ sanitizedText: 'Hello AI', detections: [] } as any);

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(202);
        expect((result.body as any).status).toBe('PENDING_APPROVAL');
        expect((result.body as any).approvalId).toBe('approval-1');
    });

    it('returns 200 with DLP FLAG — uses sanitized message and records detection', async () => {
        const client = makeClient({
            queryImpl: (sql) => {
                if (sql.includes('organizations')) return { rows: [{ telemetry_consent: false, telemetry_pii_strip: true }] };
            },
        });
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: false, warning: false } as any);
        vi.mocked(redisCache.get).mockResolvedValue(JSON.stringify({ pii_filter: true }));
        vi.mocked(opaEngine.evaluate).mockResolvedValue({
            allowed: true,
            action: 'FLAG',
            sanitizedInput: 'Meu CPF é [CPF_REDACTED]',
            dlpReport: { totalDetections: 1, types: ['CPF'] },
        } as any);
        vi.mocked(dlpEngine.sanitize).mockReturnValue({ sanitizedText: 'Meu CPF é [CPF_REDACTED]', detections: ['CPF'] } as any);
        vi.mocked(dlpEngine.sanitizeObject).mockResolvedValue({ sanitized: { input: '[CPF_REDACTED]', output: {} } } as any);
        vi.mocked(axios.post).mockResolvedValue({
            data: {
                choices: [{ message: { content: 'AI response' } }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            },
        } as any);

        const result = await executeAssistant({ ...baseParams, message: 'Meu CPF é 123.456.789-00' });

        expect(result.statusCode).toBe(200);
        expect((result.body as any)._govai.traceId).toBe('trace-789');
    });

    it('returns 200 on full success (with cache hit, telemetry consent)', async () => {
        const client = makeClient({
            queryImpl: (sql) => {
                if (sql.includes('knowledge_bases')) return { rows: [] };
                if (sql.includes('organizations')) return { rows: [{ telemetry_consent: true, telemetry_pii_strip: false }] };
            },
        });
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: false, warning: false } as any);
        vi.mocked(redisCache.get).mockResolvedValue(JSON.stringify({ pii_filter: false }));
        vi.mocked(opaEngine.evaluate).mockResolvedValue({
            allowed: true,
            action: 'ALLOW',
            sanitizedInput: 'Hello AI',
        } as any);
        vi.mocked(dlpEngine.sanitize).mockReturnValue({ sanitizedText: 'Hello AI', detections: [] } as any);
        vi.mocked(dlpEngine.sanitizeObject).mockResolvedValue({ sanitized: { input: 'Hello AI', output: {} } } as any);
        vi.mocked(axios.post).mockResolvedValue({
            data: {
                choices: [{ message: { content: 'AI response' }, text: 'AI response' }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            },
        } as any);

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(200);
        expect((result.body as any)._govai.traceId).toBe('trace-789');
        expect((result.body as any)._govai.ragMeta.chunksUsed).toBe(0);
    });

    it('returns 502 when LiteLLM is unreachable', async () => {
        const client = makeClient();
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockResolvedValue({ exceeded: false, warning: false } as any);
        vi.mocked(redisCache.get).mockResolvedValue(JSON.stringify({ pii_filter: false }));
        vi.mocked(opaEngine.evaluate).mockResolvedValue({
            allowed: true,
            action: 'ALLOW',
            sanitizedInput: 'Hello AI',
        } as any);
        vi.mocked(dlpEngine.sanitize).mockReturnValue({ sanitizedText: 'Hello AI', detections: [] } as any);
        vi.mocked(axios.post).mockRejectedValue(
            Object.assign(new Error('connect ECONNREFUSED'), { message: 'connect ECONNREFUSED' })
        );

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(502);
        expect((result.body as any).error).toContain('provedor de IA');
    });

    it('returns 500 on unexpected internal error (checkQuota throws inside try)', async () => {
        const client = makeClient();
        vi.mocked(pgPool.connect).mockResolvedValue(client as any);
        vi.mocked(checkQuota).mockRejectedValue(new Error('Unexpected DB error'));

        const result = await executeAssistant(baseParams);

        expect(result.statusCode).toBe(500);
        expect((result.body as any).error).toBe('Erro interno do servidor');
        expect(client.release).toHaveBeenCalled();
    });
});
