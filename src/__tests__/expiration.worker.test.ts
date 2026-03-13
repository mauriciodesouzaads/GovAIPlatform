/**
 * P-02: Expiration Worker — SET ROLE platform_admin / RESET ROLE
 *
 * Verifica que runExpirationSweep():
 *   1. Executa SET ROLE platform_admin ANTES do UPDATE (BYPASSRLS explícito)
 *   2. Executa RESET ROLE DEPOIS do UPDATE, em bloco finally
 *   3. Executa RESET ROLE mesmo quando o UPDATE lança exceção
 *   4. Chama client.release(err) se RESET ROLE falhar (conexão corrompida)
 *   5. Log estruturado inclui total_expired, orgs_affected e by_org
 *   6. Não emite log quando não há aprovações expiradas
 *   7. Dispara notificação para cada aprovação expirada (via notificationQueue)
 *   8. Notificações NÃO são disparadas se o UPDATE falhar
 *
 * Mocks:
 *   - ioredis: evita conexão com Redis no CI
 *   - bullmq: evita workers/queues reais
 *   - notification.worker: isola a fila de notificações
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted pelo Vitest antes dos imports) ─────────────────────────────

vi.mock('ioredis', () => ({
    default: vi.fn().mockImplementation(() => ({
        on:         vi.fn(),
        disconnect: vi.fn(),
        quit:       vi.fn(),
        status:     'ready',
    })),
}));

vi.mock('bullmq', () => ({
    Queue: vi.fn().mockImplementation(() => ({
        add:   vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
    })),
    Worker: vi.fn().mockImplementation(() => ({
        on:    vi.fn(),
        close: vi.fn(),
    })),
}));

vi.mock('../workers/notification.worker', () => ({
    notificationQueue: {
        add: vi.fn().mockResolvedValue(undefined),
    },
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

import { runExpirationSweep } from '../workers/expiration.worker';
import { notificationQueue }   from '../workers/notification.worker';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EXPIRED_ROWS = [
    { id: 'appr-001', org_id: 'org-a', assistant_id: 'asst-1', policy_reason: 'PII detected',    trace_id: 'trace-001' },
    { id: 'appr-002', org_id: 'org-a', assistant_id: 'asst-2', policy_reason: 'Quota exceeded',  trace_id: 'trace-002' },
    { id: 'appr-003', org_id: 'org-b', assistant_id: 'asst-3', policy_reason: 'Policy violation', trace_id: 'trace-003' },
];

// ── Mock helpers ──────────────────────────────────────────────────────────────

interface MockClientOpts {
    rows?:            typeof EXPIRED_ROWS;
    updateShouldFail?: boolean;
    resetShouldFail?:  boolean;
}

function buildMockClient(opts: MockClientOpts = {}) {
    const {
        rows            = EXPIRED_ROWS,
        updateShouldFail = false,
        resetShouldFail  = false,
    } = opts;

    const executedSql: string[] = [];

    const queryFn = vi.fn(async (sql: string) => {
        const normalized = sql.trim().toLowerCase().replace(/\s+/g, ' ');
        executedSql.push(normalized);

        if (normalized === 'set role platform_admin') {
            return { rows: [] };
        }

        if (normalized === 'reset role') {
            if (resetShouldFail) throw new Error('RESET ROLE: server closed the connection');
            return { rows: [] };
        }

        if (normalized.startsWith('update pending_approvals')) {
            if (updateShouldFail) throw new Error('DB connection lost during UPDATE');
            return { rows };
        }

        return { rows: [] };
    });

    const releaseFn = vi.fn();

    return {
        query:   queryFn,
        release: releaseFn,
        // Exposed for test assertions (not part of pg.Client interface)
        get executedSql() { return executedSql; },
    };
}

function buildMockPool(client: ReturnType<typeof buildMockClient>) {
    return { connect: vi.fn(async () => client) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('P-02: Expiration Worker — BYPASSRLS via SET ROLE', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── Invariante de ordem ────────────────────────────────────────────────────

    it('ORDER: SET ROLE platform_admin → UPDATE → RESET ROLE (happy path)', async () => {
        const client = buildMockClient();
        await runExpirationSweep(buildMockPool(client) as any);

        const sql = client.executedSql;
        const setRoleIdx   = sql.findIndex(s => s === 'set role platform_admin');
        const updateIdx    = sql.findIndex(s => s.startsWith('update pending_approvals'));
        const resetRoleIdx = sql.findIndex(s => s === 'reset role');

        expect(setRoleIdx,   'SET ROLE deve estar na sequência').toBeGreaterThanOrEqual(0);
        expect(updateIdx,    'UPDATE deve estar na sequência').toBeGreaterThanOrEqual(0);
        expect(resetRoleIdx, 'RESET ROLE deve estar na sequência').toBeGreaterThanOrEqual(0);

        // Invariante P-02: SET ROLE antes do UPDATE, RESET ROLE depois
        expect(setRoleIdx).toBeLessThan(updateIdx);
        expect(updateIdx).toBeLessThan(resetRoleIdx);
    });

    // ── RESET ROLE no finally — erro no UPDATE ─────────────────────────────────

    it('RESET ROLE é chamado mesmo quando o UPDATE lança exceção', async () => {
        const client = buildMockClient({ updateShouldFail: true });

        await expect(
            runExpirationSweep(buildMockPool(client) as any)
        ).rejects.toThrow('DB connection lost during UPDATE');

        // RESET ROLE deve ter sido tentado no bloco finally
        expect(client.executedSql).toContain('reset role');
    });

    it('client.release é chamado mesmo quando o UPDATE falha', async () => {
        const client = buildMockClient({ updateShouldFail: true });

        await expect(
            runExpirationSweep(buildMockPool(client) as any)
        ).rejects.toThrow();

        expect(client.release).toHaveBeenCalledTimes(1);
    });

    // ── RESET ROLE falha — client.release(err) ─────────────────────────────────

    it('client.release(err) quando RESET ROLE falha — sinaliza conexão corrompida ao pool', async () => {
        const client = buildMockClient({ resetShouldFail: true });
        await runExpirationSweep(buildMockPool(client) as any);

        // release deve ter sido chamado com um Error (conexão corrompida)
        expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    });

    it('client.release() sem argumento quando RESET ROLE e UPDATE têm sucesso', async () => {
        const client = buildMockClient();
        await runExpirationSweep(buildMockPool(client) as any);

        // release() chamado sem argumento (conexão saudável, volta ao pool)
        expect(client.release).toHaveBeenCalledWith(undefined);
    });

    // ── Log estruturado ────────────────────────────────────────────────────────

    it('log estruturado inclui total_expired, orgs_affected e by_org corretos', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const client = buildMockClient();
        await runExpirationSweep(buildMockPool(client) as any);

        // Procura chamada com JSON estruturado
        const logCall = consoleSpy.mock.calls.find(
            call => typeof call[1] === 'string' && call[1].includes('"by_org"')
        );
        expect(logCall, 'Deve ter emitido log estruturado').toBeTruthy();

        const logData = JSON.parse(logCall![1] as string);
        expect(logData.total_expired).toBe(3);
        expect(logData.orgs_affected).toBe(2);
        expect(logData.by_org['org-a']).toBe(2);
        expect(logData.by_org['org-b']).toBe(1);

        consoleSpy.mockRestore();
    });

    it('nenhum log de sweep quando não há aprovações expiradas', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const client = buildMockClient({ rows: [] });
        await runExpirationSweep(buildMockPool(client) as any);

        const sweepLog = consoleSpy.mock.calls.find(
            call => typeof call[0] === 'string' && call[0].includes('Sweep complete')
        );
        expect(sweepLog, 'Não deve emitir log de sweep quando rows = []').toBeFalsy();

        // Mas RESET ROLE ainda deve ter sido executado
        expect(client.executedSql).toContain('reset role');

        consoleSpy.mockRestore();
    });

    // ── Notificações ───────────────────────────────────────────────────────────

    it('dispara notificação para cada aprovação expirada (3 rows → 3 add calls)', async () => {
        const addSpy = vi.spyOn(notificationQueue, 'add');

        const client = buildMockClient();
        await runExpirationSweep(buildMockPool(client) as any);

        expect(addSpy).toHaveBeenCalledTimes(3);

        const [call1, call2, call3] = addSpy.mock.calls;
        expect(call1[1]).toMatchObject({ event: 'APPROVAL_EXPIRED', orgId: 'org-a', approvalId: 'appr-001' });
        expect(call2[1]).toMatchObject({ event: 'APPROVAL_EXPIRED', orgId: 'org-a', approvalId: 'appr-002' });
        expect(call3[1]).toMatchObject({ event: 'APPROVAL_EXPIRED', orgId: 'org-b', approvalId: 'appr-003' });
    });

    it('nenhuma notificação quando não há aprovações expiradas', async () => {
        const addSpy = vi.spyOn(notificationQueue, 'add');

        const client = buildMockClient({ rows: [] });
        await runExpirationSweep(buildMockPool(client) as any);

        expect(addSpy).not.toHaveBeenCalled();
    });

    it('nenhuma notificação quando o UPDATE falha (expiredRows permanece vazio)', async () => {
        const addSpy = vi.spyOn(notificationQueue, 'add');

        const client = buildMockClient({ updateShouldFail: true });

        await expect(
            runExpirationSweep(buildMockPool(client) as any)
        ).rejects.toThrow();

        // Sem UPDATE bem-sucedido, nenhuma notificação deve ser enviada
        expect(addSpy).not.toHaveBeenCalled();
    });

    // ── Prova de ausência do bypass implícito ─────────────────────────────────

    it('migration 029 dropa expiration_worker_policy e documenta o GRANT', async () => {
        const { readFileSync } = await import('fs');
        const { join }         = await import('path');

        const sql = readFileSync(
            join(process.cwd(), '029_expiration_worker_role_grant.sql'),
            'utf8'
        );

        expect(sql).toContain('DROP POLICY IF EXISTS expiration_worker_policy');
        expect(sql).toContain('GRANT platform_admin TO govai_app');
        // Não deve recriar a policy cross-tenant
        expect(sql).not.toContain('CREATE POLICY expiration_worker_policy');
    });

    it('expiration.worker.ts usa SET ROLE / RESET ROLE — sem dependência de policy cross-tenant', async () => {
        const { readFileSync } = await import('fs');
        const { join }         = await import('path');

        const src = readFileSync(
            join(process.cwd(), 'src/workers/expiration.worker.ts'),
            'utf8'
        );

        // Deve conter SET ROLE e RESET ROLE
        expect(src).toContain("'SET ROLE platform_admin'");
        expect(src).toContain("'RESET ROLE'");

        // RESET ROLE deve estar em bloco finally
        const finallyBlock = src.split('} finally {')[1];
        expect(finallyBlock, 'RESET ROLE deve estar no bloco finally').toContain("'RESET ROLE'");

        // client.release deve vir DEPOIS do RESET ROLE no finally
        const resetIdx   = finallyBlock.indexOf("'RESET ROLE'");
        const releaseIdx = finallyBlock.indexOf('client.release');
        expect(resetIdx).toBeLessThan(releaseIdx);
    });

});
