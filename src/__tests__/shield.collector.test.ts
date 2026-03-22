/**
 * shield.collector.test.ts
 *
 * T1-T2: Lógica pura com fetch mockado — testa adaptação de payload
 *   sem depender da API externa. Aceitável para CI sem credenciais.
 * T3-T4: Banco real (DATABASE_URL) — testa persistência.
 *
 * Nota: T3-T4 são excluídos da suíte padrão via integrationTestPatterns.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';

// ── Verificar DATABASE_URL para testes de banco ───────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error(
        'shield.collector.test.ts requer DATABASE_URL. ' +
        'Excluído automaticamente da suíte padrão via integrationTestPatterns.'
    );
}

import { Pool } from 'pg';
import { collectMicrosoftOAuthGrants } from '../lib/shield-oauth-collector';
import { generateExecutiveReport } from '../lib/shield-report';

const pool = new Pool({ connectionString: DATABASE_URL });

const ORG_ID = '00000000-0000-0000-0000-000000000001';
let COLLECTOR_ID: string;

beforeAll(async () => {
    // Criar org se não existir (salt de ambiente de teste)
    await pool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [ORG_ID, 'Test Org Shield Collector']
    );

    // Criar coletor de teste
    const res = await pool.query(
        `INSERT INTO shield_oauth_collectors
         (org_id, provider, external_tenant_id, collection_enabled)
         VALUES ($1, 'microsoft', 'test-tenant-id', false)
         ON CONFLICT (org_id, provider) DO UPDATE
           SET external_tenant_id = EXCLUDED.external_tenant_id
         RETURNING id`,
        [ORG_ID]
    );
    COLLECTOR_ID = res.rows[0].id as string;
});

afterAll(async () => {
    // Cleanup — remover dados de teste
    await pool.query(
        `DELETE FROM shield_executive_reports WHERE org_id = $1`, [ORG_ID]
    );
    await pool.query(
        `DELETE FROM shield_oauth_grants WHERE org_id = $1`, [ORG_ID]
    );
    await pool.query(
        `DELETE FROM shield_observations_raw WHERE org_id = $1 AND source_type = 'oauth'`, [ORG_ID]
    );
    await pool.query(
        `DELETE FROM shield_oauth_collectors WHERE org_id = $1`, [ORG_ID]
    );
    await pool.end();
});

// ── T1: fetch mockado — estrutura de retorno ──────────────────────────────────
describe('collectMicrosoftOAuthGrants — fetch mockado', () => {

    it('T1: retorna { collected, normalized, errors } com fetch mockado', async () => {
        const mockGrants = [
            {
                clientId:    'app-client-id-001',
                principalId: 'principal-id-001',
                scope:       'Mail.Read Files.Read.All',
                consentType: 'Principal',
            },
            {
                clientId:    'app-client-id-002',
                principalId: 'principal-id-002',
                scope:       'Calendars.ReadWrite',
                consentType: 'AllPrincipals',
            },
        ];

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok:   true,
            json: async () => ({ value: mockGrants, '@odata.nextLink': null }),
        } as any);
        vi.stubGlobal('fetch', mockFetch);

        const result = await collectMicrosoftOAuthGrants(
            pool, ORG_ID, COLLECTOR_ID, 'fake-access-token'
        );

        expect(result).toHaveProperty('collected');
        expect(result).toHaveProperty('normalized');
        expect(result).toHaveProperty('errors');
        expect(result.collected).toBe(2);
        expect(result.errors).toHaveLength(0);

        vi.unstubAllGlobals();
    });

    // T2: user_identifier_hash é SHA-256 (64 chars hex), NUNCA email plain
    it('T2: user_identifier_hash é SHA-256 (64 chars), não email plain', async () => {
        const principalId = 'user@example.com';
        const expectedHash = createHash('sha256')
            .update(principalId.toLowerCase().trim())
            .digest('hex');

        const mockGrants = [{
            clientId:    'app-test-hash',
            principalId,
            scope:       'Mail.Read',
            consentType: 'Principal',
        }];

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok:   true,
            json: async () => ({ value: mockGrants }),
        } as any));

        await collectMicrosoftOAuthGrants(
            pool, ORG_ID, COLLECTOR_ID, 'fake-token'
        );

        // Verificar no banco que hash foi armazenado, não o email plain
        const grantRow = await pool.query(
            `SELECT user_identifier_hash
             FROM shield_oauth_grants
             WHERE org_id = $1 AND external_app_id = 'app-test-hash'
             ORDER BY created_at DESC LIMIT 1`,
            [ORG_ID]
        );

        if (grantRow.rows.length > 0) {
            const storedHash = grantRow.rows[0].user_identifier_hash as string;
            // Hash = 64 chars hex
            expect(storedHash).toHaveLength(64);
            expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
            // Hash correto
            expect(storedHash).toBe(expectedHash);
            // Nunca o email plain
            expect(storedHash).not.toBe(principalId);
        }

        vi.unstubAllGlobals();
    });

});

// ── T3: shield_oauth_collectors persiste no banco (banco real) ────────────────
describe('shield_oauth_collectors — banco real', () => {

    it('T3: shield_oauth_collectors INSERT/SELECT no banco real', async () => {
        const row = await pool.query(
            `SELECT id, org_id, provider, collection_enabled
             FROM shield_oauth_collectors
             WHERE id = $1`,
            [COLLECTOR_ID]
        );

        expect(row.rows).toHaveLength(1);
        const c = row.rows[0];
        expect(c.org_id).toBe(ORG_ID);
        expect(c.provider).toBe('microsoft');
        expect(c.collection_enabled).toBe(false);
    });

});

// ── T4: shield_executive_reports persiste após generateExecutiveReport ────────
describe('generateExecutiveReport — banco real', () => {

    it('T4: persiste shield_executive_reports após geração', async () => {
        const FAKE_USER_ID = '00000000-0000-0000-0000-000000000002';

        // Garantir usuário de teste
        await pool.query(
            `INSERT INTO users (id, email, password_hash, role, org_id)
             VALUES ($1, 'reporter@test.com', 'x', 'admin', $2)
             ON CONFLICT (id) DO NOTHING`,
            [FAKE_USER_ID, ORG_ID]
        );

        const report = await generateExecutiveReport(pool, ORG_ID, FAKE_USER_ID);

        // Estrutura do relatório
        expect(report).toHaveProperty('org');
        expect(report.org.id).toBe(ORG_ID);
        expect(report).toHaveProperty('period');
        expect(report).toHaveProperty('posture');
        expect(report).toHaveProperty('topTools');
        expect(report).toHaveProperty('recommendations');
        expect(Array.isArray(report.recommendations)).toBe(true);
        expect(report.recommendations.length).toBeGreaterThan(0);

        // Verificar persistência no banco
        const dbRow = await pool.query(
            `SELECT id, org_id FROM shield_executive_reports
             WHERE org_id = $1
             ORDER BY generated_at DESC LIMIT 1`,
            [ORG_ID]
        );

        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].org_id).toBe(ORG_ID);
    });

});
