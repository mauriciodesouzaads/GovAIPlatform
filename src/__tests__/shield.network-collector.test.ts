/**
 * shield.network-collector.test.ts
 *
 * Testes para o network/SWG/proxy collector.
 *
 * T1-T2: Lógica pura — testa normalização de payload sem banco.
 * T3-T6: Banco real (DATABASE_URL) — persistência, RLS, hashing.
 *
 * NOTA: injetamos request.user nos testes de rota — isso testa a rota real
 * + banco real + autorização de domínio. Não testa emissão/validação de JWT.
 *
 * Excluído da suíte padrão via integrationTestPatterns em vitest.config.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error(
        'shield.network-collector.test.ts requer DATABASE_URL. ' +
        'Excluído automaticamente via integrationTestPatterns.'
    );
}

import { Pool } from 'pg';
import {
    storeNetworkCollector,
    normalizeNetworkSignal,
    ingestNetworkBatch,
    RawNetworkEvent,
} from '../lib/shield-network-collector';
import { normalizeToolName } from '../lib/shield';

const pool = new Pool({ connectionString: DATABASE_URL });

const ORG_ID         = '00000000-0000-0000-0000-000000000001';
const WRONG_ORG_ID   = '00000000-0000-0000-0000-000000000099';

let networkCollectorId: string;

function sha256(value: string): string {
    return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

beforeAll(async () => {
    // Garantir org
    await pool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [ORG_ID, 'Test Org Network Collector']
    );
});

afterAll(async () => {
    await pool.query(
        `DELETE FROM shield_network_events_raw WHERE org_id = $1`, [ORG_ID]
    ).catch(() => {});
    await pool.query(
        `DELETE FROM shield_observations_raw
         WHERE org_id = $1 AND source_type = 'network'`, [ORG_ID]
    ).catch(() => {});
    await pool.query(
        `DELETE FROM shield_network_collectors WHERE org_id = $1`, [ORG_ID]
    ).catch(() => {});
    await pool.end();
});

// ── T1: normalizeNetworkSignal — lógica pura ──────────────────────────────────

describe('T1: normalizeNetworkSignal normaliza payload de rede', () => {
    it('produz hash de user_identifier e tool_name_normalized estável', () => {
        const event: RawNetworkEvent = {
            toolName:       'ChatGPT',
            userIdentifier: 'alice@company.com',
            departmentHint: 'engineering',
            observedAt:     '2026-03-22T10:00:00Z',
        };

        const result = normalizeNetworkSignal(event);

        expect(result.toolNameNormalized).toBe('chatgpt');
        expect(result.userIdentifierHash).toBe(sha256('alice@company.com'));
        expect(result.userIdentifierHash).toHaveLength(64);
        expect(result.userIdentifierHash).not.toContain('@');
        expect(result.departmentHint).toBe('engineering');
        expect(result.observedAt).toBeInstanceOf(Date);
    });

    it('tolera evento sem userIdentifier', () => {
        const event: RawNetworkEvent = {
            toolName:   'Notion AI',
            observedAt: new Date(),
        };

        const result = normalizeNetworkSignal(event);

        expect(result.userIdentifierHash).toBeNull();
        expect(result.toolNameNormalized).toBe('notion ai');
    });
});

// ── T2: toolNameNormalized é idêntico a normalizeToolName ─────────────────────

describe('T2: normalizeNetworkSignal.toolNameNormalized é consistente com normalizeToolName', () => {
    it('outputs idênticos para mesma string', () => {
        const inputs = ['  ChatGPT  ', 'Microsoft Copilot', 'GitHub   Copilot', 'perplexity'];
        for (const input of inputs) {
            const net = normalizeNetworkSignal({ toolName: input, observedAt: new Date() });
            expect(net.toolNameNormalized).toBe(normalizeToolName(input));
        }
    });
});

// ── T3: storeNetworkCollector persiste no banco ───────────────────────────────

describe('T3: storeNetworkCollector persiste no banco', () => {
    it('cria collector e retorna registro com id', async () => {
        const collector = await storeNetworkCollector(pool, {
            orgId:         ORG_ID,
            collectorName: 'Test Proxy Collector ' + Date.now(),
            sourceKind:    'proxy',
        });

        expect(collector.id).toBeTruthy();
        expect(collector.orgId).toBe(ORG_ID);
        expect(collector.sourceKind).toBe('proxy');
        expect(collector.status).toBe('active');

        networkCollectorId = collector.id;
    });
});

// ── T4: ingestNetworkBatch persiste observações + hasha identidade ────────────

describe('T4: ingestNetworkBatch persiste observações e hash de identidade', () => {
    it('ingere lote e persiste user_identifier_hash (SHA-256, nunca plain)', async () => {
        const userEmail = `network-test-${Date.now()}@company.com`;
        const expectedHash = sha256(userEmail);

        const events: RawNetworkEvent[] = [
            {
                toolName:       'NetworkTestTool-' + Date.now(),
                userIdentifier: userEmail,
                observedAt:     new Date(),
                metadata:       { bytes: 1024 },
            },
        ];

        const result = await ingestNetworkBatch(pool, ORG_ID, networkCollectorId, events);

        expect(result.ingested).toBe(1);
        expect(result.errors).toHaveLength(0);

        // Verificar que o hash foi persistido corretamente (nunca o email)
        const client = await pool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const rows = await client.query(
                `SELECT user_identifier_hash
                 FROM shield_network_events_raw
                 WHERE org_id = $1 AND collector_id = $2
                 ORDER BY created_at DESC LIMIT 1`,
                [ORG_ID, networkCollectorId]
            );
            expect(rows.rows.length).toBeGreaterThan(0);
            expect(rows.rows[0].user_identifier_hash).toBe(expectedHash);
            expect(rows.rows[0].user_identifier_hash).not.toContain('@');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    it('eventos sem toolName são ignorados silenciosamente', async () => {
        const events: RawNetworkEvent[] = [
            { toolName: '', observedAt: new Date() } as any,
            { toolName: 'ValidTool-' + Date.now(), observedAt: new Date() },
        ];

        const result = await ingestNetworkBatch(pool, ORG_ID, networkCollectorId, events);

        expect(result.ingested).toBe(1);
        expect(result.errors.length).toBeGreaterThan(0);
    });
});

// ── T5: observações de rede chegam ao pipeline shield_observations_raw ────────

describe('T5: ingestNetworkBatch alimenta shield_observations_raw com source_type=network', () => {
    it('observação de rede aparece no pipeline principal do Shield', async () => {
        const toolName = 'Pipeline-Test-' + Date.now();
        const events: RawNetworkEvent[] = [
            { toolName, observedAt: new Date() },
        ];

        await ingestNetworkBatch(pool, ORG_ID, networkCollectorId, events);

        const client = await pool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const rows = await client.query(
                `SELECT source_type, tool_name_normalized
                 FROM shield_observations_raw
                 WHERE org_id = $1 AND tool_name = $2
                 LIMIT 1`,
                [ORG_ID, toolName]
            );
            expect(rows.rows.length).toBe(1);
            expect(rows.rows[0].source_type).toBe('network');
            expect(rows.rows[0].tool_name_normalized).toBe(normalizeToolName(toolName));
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T6: RLS — org errada não vê eventos da org correta ───────────────────────

describe('T6: RLS — shield_network_events_raw isolado por org', () => {
    it('org errada retorna 0 rows para eventos da org correta', async () => {
        const client = await pool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [WRONG_ORG_ID]
            );
            const rows = await client.query(
                `SELECT count(*) AS cnt FROM shield_network_events_raw
                 WHERE org_id = $1`,
                [ORG_ID]
            );
            expect(Number(rows.rows[0].cnt)).toBe(0);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});
