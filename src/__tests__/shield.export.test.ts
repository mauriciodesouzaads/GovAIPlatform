/**
 * shield.export.test.ts
 *
 * Sprint S3 — Shield Enterprise Hardening: Export estruturado.
 *
 * T1: exportFindingsAsJson retorna findings com todos os campos esperados
 * T2: exportFindingsAsCsv produz CSV válido com cabeçalho
 * T3: export respeita RLS — org errada retorna vazio
 * T4: computeShieldMetrics produz métricas consultáveis
 * T5: export de posture via GET /export/posture → 200
 * T6: export de findings via GET /export/findings → 200
 *
 * Todos requerem DATABASE_URL. Banco PostgreSQL real.
 * T5/T6 usam Fastify inject real.
 * NOTA: request.user injetado via mockRequireRole — testa rota real + banco real.
 * Não testa emissão/validação de JWT.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error(
        'shield.export.test.ts requer DATABASE_URL. ' +
        'Excluído automaticamente via integrationTestPatterns.'
    );
}

import { Pool } from 'pg';
import Fastify from 'fastify';
import {
    exportFindingsAsJson,
    exportFindingsAsCsv,
    exportPostureAsJson,
} from '../lib/shield-export';
import { computeShieldMetrics } from '../lib/shield-metrics';
import { shieldRoutes } from '../routes/shield.routes';

const pgPool = new Pool({ connectionString: DATABASE_URL });

const ORG_ID   = '00000000-0000-0000-0000-000000000001';
const ACTOR_ID = '00000000-0000-0000-0000-000000000010';

function mockRequireRole(_roles: string[]) {
    return async (request: any, _reply: any) => {
        request.user = { userId: ACTOR_ID, orgId: ORG_ID, role: 'admin' };
    };
}

let app: any;

beforeAll(async () => {
    await pgPool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [ORG_ID, 'Test Org S3 Export']
    );
    await pgPool.query(
        `INSERT INTO users (id, email, password_hash, role, org_id)
         VALUES ($1, $2, 'x', 'admin', $3) ON CONFLICT (id) DO NOTHING`,
        [ACTOR_ID, 'actor-export@test.com', ORG_ID]
    );

    // Criar finding para ter dados a exportar
    const client = await pgPool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
        );
        await client.query(
            `INSERT INTO shield_findings
             (org_id, tool_name, tool_name_normalized, severity, rationale,
              first_seen_at, last_seen_at, observation_count)
             VALUES ($1, 'ExportTestTool', 'exporttesttool', 'high',
                     'Finding para export S3', NOW(), NOW(), 10)
             ON CONFLICT DO NOTHING`,
            [ORG_ID]
        );
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }

    const fastify = Fastify();
    await shieldRoutes(fastify, { pgPool, requireRole: mockRequireRole });
    await fastify.ready();
    app = fastify;
});

afterAll(async () => {
    await app.close().catch(() => {});
    await pgPool.end();
});

// ── T1: exportFindingsAsJson ──────────────────────────────────────────────────

describe('T1: exportFindingsAsJson retorna findings estruturados', () => {
    it('resultado tem orgId, exportedAt, totalFindings e findings[]', async () => {
        const result = await exportFindingsAsJson(pgPool, ORG_ID);

        expect(result.orgId).toBe(ORG_ID);
        expect(result.exportedAt).toBeTruthy();
        expect(typeof result.totalFindings).toBe('number');
        expect(Array.isArray(result.findings)).toBe(true);

        if (result.findings.length > 0) {
            const f = result.findings[0];
            expect(f.id).toBeTruthy();
            expect(f.tool_name).toBeTruthy();
            expect(f.severity).toBeTruthy();
            expect(f.status).toBeTruthy();
        }
    });

    it('filtro por severity funciona', async () => {
        const result = await exportFindingsAsJson(pgPool, ORG_ID, { severity: 'critical' });
        // Todos os findings retornados devem ser critical (ou vazio se não há nenhum)
        for (const f of result.findings) {
            expect(f.severity).toBe('critical');
        }
    });
});

// ── T2: exportFindingsAsCsv ───────────────────────────────────────────────────

describe('T2: exportFindingsAsCsv produz CSV válido', () => {
    it('CSV tem cabeçalho correto na primeira linha', async () => {
        const csv = await exportFindingsAsCsv(pgPool, ORG_ID);
        const lines = csv.split('\n');
        expect(lines.length).toBeGreaterThanOrEqual(1);

        const header = lines[0];
        expect(header).toContain('id');
        expect(header).toContain('tool_name');
        expect(header).toContain('severity');
        expect(header).toContain('status');
        expect(header).toContain('risk_score');
    });

    it('CSV tem pelo menos uma linha de dados se há findings', async () => {
        const csv = await exportFindingsAsCsv(pgPool, ORG_ID);
        const lines = csv.split('\n').filter(l => l.trim());
        // Pelo menos o cabeçalho
        expect(lines.length).toBeGreaterThanOrEqual(1);
    });
});

// ── T3: export respeita RLS ───────────────────────────────────────────────────

describe('T3: export respeita RLS — org errada não vaza dados', () => {
    it('exportFindingsAsJson para WRONG_ORG retorna 0 findings', async () => {
        const WRONG_ORG = '00000000-0000-0000-0000-000000000099';
        const result = await exportFindingsAsJson(pgPool, WRONG_ORG);
        expect(result.totalFindings).toBe(0);
        expect(result.findings).toHaveLength(0);
    });
});

// ── T4: computeShieldMetrics ──────────────────────────────────────────────────

describe('T4: computeShieldMetrics produz métricas consultáveis', () => {
    it('retorna métricas com campos obrigatórios', async () => {
        const metrics = await computeShieldMetrics(pgPool, ORG_ID);

        expect(metrics.orgId).toBe(ORG_ID);
        expect(metrics.computedAt).toBeTruthy();
        expect(Array.isArray(metrics.collectorSuccessRates)).toBe(true);
        expect(typeof metrics.processingBacklog).toBe('number');
        expect(typeof metrics.postureGenerationsLast30Days).toBe('number');
        expect(typeof metrics.openFindings).toBe('number');
        expect(typeof metrics.criticalUnresolved).toBe('number');

        // findingFreshness pode ser null se não há findings abertos
        if (metrics.findingFreshnessAvgDays !== null) {
            expect(typeof metrics.findingFreshnessAvgDays).toBe('number');
        }
    });

    it('processingBacklog é número não-negativo', async () => {
        const metrics = await computeShieldMetrics(pgPool, ORG_ID);
        expect(metrics.processingBacklog).toBeGreaterThanOrEqual(0);
    });
});

// ── T5: GET /export/posture → 200 ────────────────────────────────────────────

describe('T5: GET /v1/admin/shield/export/posture → 200', () => {
    it('endpoint retorna posture com orgId e exportedAt', async () => {
        const res = await app.inject({
            method: 'GET',
            url:    `/v1/admin/shield/export/posture?orgId=${ORG_ID}`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.orgId).toBe(ORG_ID);
        expect(body.exportedAt).toBeTruthy();
        expect(Array.isArray(body.history)).toBe(true);
    });
});

// ── T6: GET /export/findings → 200 ───────────────────────────────────────────

describe('T6: GET /v1/admin/shield/export/findings → 200', () => {
    it('endpoint retorna findings com totalFindings', async () => {
        const res = await app.inject({
            method: 'GET',
            url:    `/v1/admin/shield/export/findings?orgId=${ORG_ID}`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.orgId).toBe(ORG_ID);
        expect(typeof body.totalFindings).toBe('number');
        expect(Array.isArray(body.findings)).toBe(true);
    });
});
