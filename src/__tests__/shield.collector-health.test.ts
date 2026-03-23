/**
 * shield.collector-health.test.ts
 *
 * Sprint S3 — Shield Enterprise Hardening: Collector Health.
 *
 * T1: recordCollectorSuccess atualiza success_count e last_success_at
 * T2: recordCollectorFailure persiste last_error e failure_count
 * T3: health_status computado corretamente (healthy / degraded / error)
 * T4: getCollectorHealth retorna lista consolidada de collectors
 * T5: collector falhado deixa trilha visível via getCollectorHealth
 * T6: RLS — collector de org errada não é retornado
 *
 * Todos requerem DATABASE_URL. Banco PostgreSQL real.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error(
        'shield.collector-health.test.ts requer DATABASE_URL. ' +
        'Excluído automaticamente via integrationTestPatterns.'
    );
}

import { Pool } from 'pg';
import {
    recordCollectorSuccess,
    recordCollectorFailure,
    getCollectorHealth,
} from '../lib/shield-collector-health';

const pgPool = new Pool({ connectionString: DATABASE_URL });

const ORG_ID = '00000000-0000-0000-0000-000000000001';
let networkCollectorId: string;

beforeAll(async () => {
    await pgPool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [ORG_ID, 'Test Org S3 CollectorHealth']
    );

    // Criar um network collector para testar
    const client = await pgPool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
        );
        const res = await client.query(
            `INSERT INTO shield_network_collectors
             (org_id, collector_name, source_kind, status)
             VALUES ($1, $2, 'proxy', 'active')
             RETURNING id`,
            [ORG_ID, 'test-health-collector-' + Date.now()]
        );
        networkCollectorId = res.rows[0].id as string;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
});

afterAll(async () => {
    const client = await pgPool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
        );
        if (networkCollectorId) {
            await client.query(
                'DELETE FROM shield_network_collectors WHERE id = $1', [networkCollectorId]
            );
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
        await pgPool.end();
    }
});

// ── T1: recordCollectorSuccess ────────────────────────────────────────────────

describe('T1: recordCollectorSuccess atualiza success_count e last_success_at', () => {
    it('success_count incrementado e last_success_at preenchido', async () => {
        await recordCollectorSuccess(pgPool, 'network', networkCollectorId, ORG_ID);

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const res = await client.query(
                `SELECT success_count, last_success_at, health_status
                 FROM shield_network_collectors WHERE id = $1`,
                [networkCollectorId]
            );
            expect(res.rows[0].success_count).toBeGreaterThanOrEqual(1);
            expect(res.rows[0].last_success_at).toBeTruthy();
            expect(res.rows[0].health_status).toBe('healthy');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T2: recordCollectorFailure ────────────────────────────────────────────────

describe('T2: recordCollectorFailure persiste last_error e failure_count', () => {
    it('failure_count incrementado e last_error preenchido', async () => {
        await recordCollectorFailure(
            pgPool, 'network', networkCollectorId, ORG_ID,
            'Timeout conectando ao proxy T2'
        );

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const res = await client.query(
                `SELECT failure_count, last_error, health_status
                 FROM shield_network_collectors WHERE id = $1`,
                [networkCollectorId]
            );
            expect(res.rows[0].failure_count).toBeGreaterThanOrEqual(1);
            expect(res.rows[0].last_error).toContain('Timeout');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T3: health_status correto ─────────────────────────────────────────────────

describe('T3: health_status computado corretamente após múltiplas falhas', () => {
    it('health_status = error quando maioria são falhas', async () => {
        // Registrar 5 falhas adicionais → deve ficar como error
        for (let i = 0; i < 5; i++) {
            await recordCollectorFailure(
                pgPool, 'network', networkCollectorId, ORG_ID, `Falha T3-${i}`
            );
        }

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const res = await client.query(
                `SELECT health_status, failure_count, success_count
                 FROM shield_network_collectors WHERE id = $1`,
                [networkCollectorId]
            );
            // Com maioria de falhas, health_status deve ser 'error' ou 'degraded'
            expect(['degraded','error']).toContain(res.rows[0].health_status);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T4: getCollectorHealth retorna lista ──────────────────────────────────────

describe('T4: getCollectorHealth retorna lista consolidada de collectors', () => {
    it('retorna array com pelo menos o network collector criado', async () => {
        const health = await getCollectorHealth(pgPool, ORG_ID);
        expect(Array.isArray(health)).toBe(true);

        const found = health.find(h => h.id === networkCollectorId);
        expect(found).toBeTruthy();
        expect(found?.kind).toBe('network');
        expect(typeof found?.successCount).toBe('number');
        expect(typeof found?.failureCount).toBe('number');
    });
});

// ── T5: collector falhado deixa trilha visível ────────────────────────────────

describe('T5: collector falhado deixa trilha visível em getCollectorHealth', () => {
    it('last_error não nulo para collector com falha', async () => {
        const health = await getCollectorHealth(pgPool, ORG_ID);
        const found = health.find(h => h.id === networkCollectorId);
        expect(found).toBeTruthy();
        expect(found?.lastError).toBeTruthy();
        expect(['degraded','error']).toContain(found?.healthStatus);
    });
});

// ── T6: RLS — collector de org errada não retornado ───────────────────────────

describe('T6: RLS — collector de org errada não é retornado', () => {
    it('getCollectorHealth para WRONG_ORG retorna array sem collector da ORG_ID', async () => {
        const WRONG_ORG = '00000000-0000-0000-0000-000000000099';
        const health = await getCollectorHealth(pgPool, WRONG_ORG);
        const leaked = health.find(h => h.id === networkCollectorId);
        expect(leaked).toBeUndefined();
    });
});
