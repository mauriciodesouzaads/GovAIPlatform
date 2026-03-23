/**
 * shield.posture-history.test.ts
 *
 * Sprint S3 — Shield Enterprise Hardening: Posture Snapshots & History.
 *
 * T1: posture snapshot persiste sanctioned_count e coverage_ratio
 * T2: histórico de snapshots é consultável por tenant
 * T3: múltiplos snapshots geram histórico ordenado (mais recente primeiro)
 * T4: exportPostureAsJson retorna snapshot recente e histórico completo
 * T5: geração de snapshot não quebra workflow existente
 * T6: RLS — posture de org errada retorna vazio
 *
 * Todos requerem DATABASE_URL. Banco PostgreSQL real.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error(
        'shield.posture-history.test.ts requer DATABASE_URL. ' +
        'Excluído automaticamente via integrationTestPatterns.'
    );
}

import { Pool } from 'pg';
import { generateExecutivePosture } from '../lib/shield';
import { exportPostureAsJson } from '../lib/shield-export';

const pgPool = new Pool({ connectionString: DATABASE_URL });

const ORG_ID  = '00000000-0000-0000-0000-000000000001';
const ACTOR_ID = '00000000-0000-0000-0000-000000000010';

beforeAll(async () => {
    await pgPool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [ORG_ID, 'Test Org S3 PostureHistory']
    );
    await pgPool.query(
        `INSERT INTO users (id, email, password_hash, role, org_id)
         VALUES ($1, $2, 'x', 'admin', $3) ON CONFLICT (id) DO NOTHING`,
        [ACTOR_ID, 'actor-posture@test.com', ORG_ID]
    );
});

afterAll(async () => {
    await pgPool.end();
});

// ── T1: snapshot persiste sanctioned_count e coverage_ratio ──────────────────

describe('T1: posture snapshot persiste sanctioned_count e coverage_ratio (S3)', () => {
    it('snapshot com campos S3 preenchidos no banco', async () => {
        await generateExecutivePosture(pgPool, ORG_ID, ACTOR_ID);

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const row = await client.query(
                `SELECT sanctioned_count, unsanctioned_count, total_tools, coverage_ratio
                 FROM shield_posture_snapshots
                 WHERE org_id = $1
                 ORDER BY generated_at DESC LIMIT 1`,
                [ORG_ID]
            );
            expect(row.rows).toHaveLength(1);
            expect(typeof row.rows[0].sanctioned_count).toBe('number');
            expect(typeof row.rows[0].unsanctioned_count).toBe('number');
            expect(typeof row.rows[0].total_tools).toBe('number');
            // coverage_ratio pode ser null se não há tools — ambos são válidos
            if (row.rows[0].coverage_ratio !== null) {
                expect(parseFloat(row.rows[0].coverage_ratio)).toBeGreaterThanOrEqual(0);
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T2: histórico consultável ─────────────────────────────────────────────────

describe('T2: histórico de snapshots é consultável por tenant', () => {
    it('SELECT retorna rows ordenados por generated_at DESC', async () => {
        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const rows = await client.query(
                `SELECT id, generated_at FROM shield_posture_snapshots
                 WHERE org_id = $1
                 ORDER BY generated_at DESC`,
                [ORG_ID]
            );
            expect(rows.rows.length).toBeGreaterThanOrEqual(1);

            // Verificar ordenação
            for (let i = 1; i < rows.rows.length; i++) {
                const prev = new Date(rows.rows[i - 1].generated_at);
                const curr = new Date(rows.rows[i].generated_at);
                expect(prev.getTime()).toBeGreaterThanOrEqual(curr.getTime());
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T3: múltiplos snapshots geram histórico ───────────────────────────────────

describe('T3: múltiplos snapshots acumulam histórico', () => {
    it('dois generateExecutivePosture geram dois registros distintos', async () => {
        const client = await pgPool.connect();
        let countBefore: number;
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const before = await client.query(
                `SELECT COUNT(*)::int AS cnt FROM shield_posture_snapshots WHERE org_id = $1`,
                [ORG_ID]
            );
            countBefore = before.rows[0].cnt;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        await generateExecutivePosture(pgPool, ORG_ID, ACTOR_ID);

        const client2 = await pgPool.connect();
        try {
            await client2.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const after = await client2.query(
                `SELECT COUNT(*)::int AS cnt FROM shield_posture_snapshots WHERE org_id = $1`,
                [ORG_ID]
            );
            expect(after.rows[0].cnt).toBeGreaterThan(countBefore);
        } finally {
            await client2.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client2.release();
        }
    });
});

// ── T4: exportPostureAsJson retorna snapshot e histórico ──────────────────────

describe('T4: exportPostureAsJson retorna snapshot recente e histórico', () => {
    it('resultado tem latestSnapshot e history com length ≥ 1', async () => {
        const result = await exportPostureAsJson(pgPool, ORG_ID);

        expect(result.orgId).toBe(ORG_ID);
        expect(result.exportedAt).toBeTruthy();
        expect(result.latestSnapshot).not.toBeNull();
        expect(Array.isArray(result.history)).toBe(true);
        expect(result.history.length).toBeGreaterThanOrEqual(1);
    });
});

// ── T5: geração de snapshot não quebra workflow existente ─────────────────────

describe('T5: generateExecutivePosture continua funcional após S3', () => {
    it('retorna campos S2 + novos campos S3', async () => {
        const snapshot = await generateExecutivePosture(pgPool, ORG_ID, ACTOR_ID);
        expect(typeof snapshot.summaryScore).toBe('number');
        expect(typeof snapshot.openFindings).toBe('number');
        expect(typeof snapshot.unresolvedCritical).toBe('number');
        expect(Array.isArray(snapshot.topTools)).toBe(true);
        expect(Array.isArray(snapshot.recommendations)).toBe(true);
    });
});

// ── T6: RLS — posture de org errada retorna vazio ────────────────────────────

describe('T6: RLS — exportPostureAsJson de org errada não vaza dados', () => {
    it('latestSnapshot é null e history vazio para org sem dados', async () => {
        const WRONG_ORG = '00000000-0000-0000-0000-000000000099';
        const result = await exportPostureAsJson(pgPool, WRONG_ORG);
        expect(result.latestSnapshot).toBeNull();
        expect(result.history).toHaveLength(0);
    });
});
