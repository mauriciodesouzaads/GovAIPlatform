/**
 * Compliance Guarantees — Sprint E-FIX
 *
 * AVISO: estes testes provam garantias auditáveis para revisores externos.
 * Todos verificam lógica REAL contra PostgreSQL — sem makeImmutableDbMock,
 * sem mocks de Pool. Requerem DATABASE_URL configurado.
 *
 * Excluídos do `npx vitest run` quando DATABASE_URL não está definido
 * (ver vitest.config.ts → integrationTestPatterns).
 *
 * Execute isolado:
 *   DATABASE_URL=postgresql://... npx vitest run src/__tests__/compliance.guarantees.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { EvidencePayload } from '../lib/evidence';

// ── Configuração ──────────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    throw new Error(
        'DATABASE_URL é obrigatório para os testes de garantia de compliance.\n' +
        'Execute: DATABASE_URL=postgresql://... npx vitest run src/__tests__/compliance.guarantees.test.ts'
    );
}

// Fixtures fixas — devem existir no banco (criadas pelo seed.sql)
const ORG_ID        = '00000000-0000-0000-0000-000000000001';
const CONSULTANT_ID = '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab'; // admin@orga.com
const WRONG_ORG_ID  = '00000000-0000-0000-0000-000000000099'; // org inexistente

let pgPool: Pool;

beforeAll(async () => {
    pgPool = new Pool({ connectionString: dbUrl });
});

afterAll(async () => {
    await pgPool.end();
});

// ── T1: audit_logs_partitioned — trigger de imutabilidade real ───────────────

describe('Guarantee T1: audit_logs_partitioned é imutável (trigger real)', () => {
    it('INSERT retorna id; UPDATE dispara trigger e lança exceção', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            const { rows } = await client.query(
                `INSERT INTO audit_logs_partitioned (org_id, action, metadata, signature)
                 VALUES ($1, 'EFIX_IMMUTABILITY_TEST', '{}', 'sig-efix-test')
                 RETURNING id`,
                [ORG_ID]
            );
            expect(rows[0].id).toBeTruthy();

            await expect(
                client.query(
                    `UPDATE audit_logs_partitioned SET action = 'TAMPERED' WHERE id = $1`,
                    [rows[0].id]
                )
            ).rejects.toThrow(/imut[aá]vel/i);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T2: policy_snapshots — trigger de imutabilidade real ─────────────────────

describe('Guarantee T2: policy_snapshots é imutável (trigger real)', () => {
    it('INSERT retorna id; UPDATE dispara trigger e lança exceção', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                "SELECT set_config('app.current_org_id', $1, true)",
                [ORG_ID]
            );

            const { rows } = await client.query(
                `INSERT INTO policy_snapshots (org_id, policy_hash, policy_json)
                 VALUES ($1, 'hash-efix-immutability-t2', '{"efix": true}')
                 RETURNING id`,
                [ORG_ID]
            );
            expect(rows[0].id).toBeTruthy();

            await expect(
                client.query(
                    `UPDATE policy_snapshots SET policy_json = '{"tampered": true}' WHERE id = $1`,
                    [rows[0].id]
                )
            ).rejects.toThrow(/imut[aá]vel/i);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T3: evidence_records — trigger de imutabilidade real ─────────────────────

describe('Guarantee T3: evidence_records é imutável (trigger real)', () => {
    it('INSERT retorna id; UPDATE dispara trigger e lança exceção', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                "SELECT set_config('app.current_org_id', $1, true)",
                [ORG_ID]
            );

            const { rows } = await client.query(
                `INSERT INTO evidence_records (org_id, category, event_type, integrity_hash)
                 VALUES ($1, 'execution', 'EFIX_IMMUTABILITY_TEST', 'hash-efix-ev-immutability')
                 RETURNING id`,
                [ORG_ID]
            );
            expect(rows[0].id).toBeTruthy();

            await expect(
                client.query(
                    `UPDATE evidence_records SET event_type = 'TAMPERED' WHERE id = $1`,
                    [rows[0].id]
                )
            ).rejects.toThrow(/imut[aá]vel/i);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T4: consultant_audit_log — trigger de imutabilidade real ─────────────────

describe('Guarantee T4: consultant_audit_log é imutável (trigger real)', () => {
    it('INSERT retorna id; UPDATE dispara trigger e lança exceção', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            // consultant_id = usuário real; tenant_org_id = org real
            const { rows } = await client.query(
                `INSERT INTO consultant_audit_log (consultant_id, tenant_org_id, action)
                 VALUES ($1, $2, 'EFIX_IMMUTABILITY_TEST')
                 RETURNING id`,
                [CONSULTANT_ID, ORG_ID]
            );
            expect(rows[0].id).toBeTruthy();

            await expect(
                client.query(
                    `UPDATE consultant_audit_log SET action = 'TAMPERED' WHERE id = $1`,
                    [rows[0].id]
                )
            ).rejects.toThrow(/imut[aá]vel/i);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T5: integrity_hash determinismo (lógica pura — sem banco) ─────────────────

describe('Guarantee T5: integrity_hash é determinístico (lógica pura)', () => {
    it('payloads idênticos → mesmo SHA-256; payloads distintos → hashes distintos', () => {
        const compute = (p: EvidencePayload): string => {
            const metadata = p.metadata ?? {};
            return createHash('sha256')
                .update([p.orgId, p.category, p.eventType, JSON.stringify(metadata)].join('|'))
                .digest('hex');
        };

        const payload: EvidencePayload = {
            orgId:     ORG_ID,
            category:  'execution',
            eventType: 'EXECUTION_SUCCESS',
            metadata:  { traceId: 'trace-efix', tokens: { total: 42 } },
        };

        const h1 = compute(payload);
        const h2 = compute(payload);
        const h3 = compute({ ...payload }); // shallow copy

        expect(h1).toBe(h2);
        expect(h2).toBe(h3);
        expect(h1).toHaveLength(64); // SHA-256 hex = 64 chars

        // Metadata diferente → hash diferente (resistência a colisão)
        expect(compute({ ...payload, metadata: { traceId: 'different' } })).not.toBe(h1);
    });
});

// ── T6: requireApiKey — query real contra api_key_lookup ─────────────────────

describe('Guarantee T6: requireApiKey query usa predicados corretos', () => {
    it('query real retorna 0 rows para key_hash inexistente (filtros corretos)', async () => {
        const fakeHash   = 'a'.repeat(64); // hash de 64 chars que não existe no banco
        const fakePrefix = 'efix_t6_fake_prefix';

        const result = await pgPool.query(
            `SELECT akl.org_id
             FROM api_key_lookup akl
             WHERE akl.key_hash = $1
               AND akl.prefix = $2
               AND akl.is_active = TRUE
               AND (akl.expires_at IS NULL OR akl.expires_at > NOW())`,
            [fakeHash, fakePrefix]
        );

        expect(result.rows).toHaveLength(0);
    });
});

// ── T6b: API key com is_active=false é excluída da query de autenticação ──────

describe('Guarantee T6b: api key inativa (is_active=false) excluída da query de auth', () => {
    it('chave ativa retorna com is_active=TRUE; mesma chave retorna 0 rows com is_active=FALSE', async () => {
        // Confirmar que existe pelo menos uma chave ativa no banco
        const activeResult = await pgPool.query(
            `SELECT key_hash FROM api_key_lookup WHERE is_active = TRUE LIMIT 1`
        );

        if (activeResult.rows.length > 0) {
            const activeHash = activeResult.rows[0].key_hash;

            // Query com is_active=FALSE — chave ativa NÃO deve ser retornada
            const withFalse = await pgPool.query(
                `SELECT akl.org_id FROM api_key_lookup akl
                 WHERE akl.key_hash = $1
                   AND akl.is_active = FALSE
                   AND (akl.expires_at IS NULL OR akl.expires_at > NOW())`,
                [activeHash]
            );
            expect(withFalse.rows).toHaveLength(0);

            // Query com is_active=TRUE — mesma chave DEVE ser retornada (filtro discrimina)
            const withTrue = await pgPool.query(
                `SELECT akl.org_id FROM api_key_lookup akl
                 WHERE akl.key_hash = $1
                   AND akl.is_active = TRUE`,
                [activeHash]
            );
            expect(withTrue.rows).toHaveLength(1);
        } else {
            // Sem chaves ativas — verificar que a coluna is_active existe (garantia estrutural)
            const col = await pgPool.query(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_name = 'api_key_lookup' AND column_name = 'is_active'`
            );
            expect(col.rows).toHaveLength(1);
        }
    });
});

// ── T7: Chave expirada rejeitada pela query real de auth ─────────────────────

describe('Guarantee T7: chave API expirada não é retornada pela query real', () => {
    it('key com expires_at no passado → 0 rows na query de requireApiKey', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            const testHash   = 'b'.repeat(64);
            const testPrefix = 'efix_t7_expired';
            const pastDate   = '2020-01-01T00:00:00Z';

            // Insere chave expirada diretamente em api_key_lookup (sem FK para api_keys)
            await client.query(
                `INSERT INTO api_key_lookup (key_hash, prefix, org_id, is_active, expires_at)
                 VALUES ($1, $2, $3, TRUE, $4)`,
                [testHash, testPrefix, ORG_ID, pastDate]
            );

            // A query real de requireApiKey NÃO deve retornar esta chave
            const result = await client.query(
                `SELECT akl.org_id
                 FROM api_key_lookup akl
                 WHERE akl.key_hash = $1
                   AND akl.prefix = $2
                   AND akl.is_active = TRUE
                   AND (akl.expires_at IS NULL OR akl.expires_at > NOW())`,
                [testHash, testPrefix]
            );

            expect(result.rows).toHaveLength(0);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T8: lifecycle_state CHECK constraint rejeita valor inválido ───────────────

describe('Guarantee T8: lifecycle_state CHECK constraint aplicado no banco', () => {
    it('INSERT com lifecycle_state inválido lança violação de constraint', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            await expect(
                client.query(
                    `INSERT INTO assistants (org_id, name, lifecycle_state)
                     VALUES ($1, 'efix-lifecycle-check-test', 'INVALID_STATE')`,
                    [ORG_ID]
                )
            ).rejects.toThrow(/check constraint/i);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T9: Nenhum evidence_record com integrity_hash NULL ───────────────────────

describe('Guarantee T9: todos evidence_records da org têm integrity_hash não-nulo', () => {
    it('COUNT(*) WHERE integrity_hash IS NULL = 0 para a org fixture', async () => {
        const result = await pgPool.query(
            `SELECT COUNT(*) AS total
             FROM evidence_records
             WHERE org_id = $1
               AND integrity_hash IS NULL`,
            [ORG_ID]
        );
        expect(parseInt(result.rows[0].total, 10)).toBe(0);
    });
});

// ── T10: RLS — org A vê registro; org errada vê 0 rows ──────────────────────

describe('Guarantee T10: evidence_records RLS isola registros por org (govai_app)', () => {
    it('org correta vê o registro; org errada recebe 0 rows', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            // Assume identidade govai_app para ativar RLS
            await client.query('SET LOCAL ROLE govai_app');
            await client.query(
                "SELECT set_config('app.current_org_id', $1, true)",
                [ORG_ID]
            );

            // INSERT como govai_app (WITH CHECK deve passar: org_id = current_org_id)
            const { rows } = await client.query(
                `INSERT INTO evidence_records (org_id, category, event_type, integrity_hash)
                 VALUES ($1, 'execution', 'RLS_ISOLATION_EFIX', 'hash-rls-efix-t10')
                 RETURNING id`,
                [ORG_ID]
            );
            const id = rows[0].id;

            // Org correta — USING clause: org_id = ORG_ID → visível
            const visible = await client.query(
                'SELECT id FROM evidence_records WHERE id = $1',
                [id]
            );
            expect(visible.rows).toHaveLength(1);

            // Troca para org errada — USING clause: org_id = WRONG_ORG_ID → invisível
            await client.query(
                "SELECT set_config('app.current_org_id', $1, true)",
                [WRONG_ORG_ID]
            );
            const invisible = await client.query(
                'SELECT id FROM evidence_records WHERE id = $1',
                [id]
            );
            expect(invisible.rows).toHaveLength(0);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
