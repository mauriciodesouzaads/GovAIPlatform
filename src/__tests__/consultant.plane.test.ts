/**
 * Consultant Plane Tests — Sprint E-FIX
 *
 * NOTA DE SEGURANÇA: O preHandler injeta request.user diretamente no objeto de
 * requisição via mock de requireTenantRole — NÃO testa JWT. O objetivo é
 * validar a lógica de negócio do plano de consultores (atribuições, 403, logs),
 * não o fluxo de autenticação (coberto por testes de integração separados).
 *
 * Todos os testes usam PostgreSQL real e Fastify inject real.
 * Requerem DATABASE_URL configurado.
 *
 * Execute isolado:
 *   DATABASE_URL=postgresql://... npx vitest run src/__tests__/consultant.plane.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    getConsultantAssignment,
    getConsultantPortfolio,
    logConsultantAction,
} from '../lib/consultant-auth';
import { consultantRoutes } from '../routes/consultant.routes';

// ── Configuração ──────────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    throw new Error(
        'DATABASE_URL é obrigatório para os testes do Consultant Plane.\n' +
        'Execute: DATABASE_URL=postgresql://... npx vitest run src/__tests__/consultant.plane.test.ts'
    );
}

// Fixtures fixas — devem existir no banco (criadas pelo seed.sql)
const CONSULTANT_ID = '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab'; // admin@orga.com
const ORG_ID        = '00000000-0000-0000-0000-000000000001';
const NONEXISTENT_ORG = '00000000-0000-0000-0000-999999999999';

let pgPool: Pool;
let app: FastifyInstance;

/**
 * mock de requireTenantRole: bypassa JWT, injeta request.user diretamente.
 * NÃO replica verificação de roles — foco é na lógica de negócio pós-auth.
 */
const mockRequireTenantRole = (_roles: string[]) =>
    async (request: any) => {
        request.user = {
            userId: CONSULTANT_ID,
            orgId:  ORG_ID,
            email:  'admin@orga.com',
        };
    };

beforeAll(async () => {
    pgPool = new Pool({ connectionString: dbUrl });

    app = Fastify({ logger: false });
    await app.register(consultantRoutes, {
        pgPool,
        requireTenantRole: mockRequireTenantRole,
    });
    await app.ready();
});

afterAll(async () => {
    await app.close();
    await pgPool.end();
});

// ── T1: GET /v1/consultant/portfolio — retorna estrutura correta ──────────────

describe('T1: GET /v1/consultant/portfolio', () => {
    it('retorna 200 com array tenants e campo total coerente', async () => {
        const res = await app.inject({
            method: 'GET',
            url:    '/v1/consultant/portfolio',
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.tenants)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(body.total).toBe(body.tenants.length);
    });
});

// ── T2: GET /v1/consultant/tenants/:tenantOrgId/summary — sem atribuição → 403

describe('T2: GET /v1/consultant/tenants/:id/summary sem atribuição retorna 403', () => {
    it('org inexistente → 403 (sem assignment ativo)', async () => {
        const res = await app.inject({
            method: 'GET',
            url:    `/v1/consultant/tenants/${NONEXISTENT_ORG}/summary`,
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBeTruthy();
    });
});

// ── T3: getConsultantAssignment retorna null para assignment revogado ─────────

describe('T3: getConsultantAssignment — assignment revogado → null (banco real)', () => {
    it('revoked_at IS NOT NULL faz a query retornar null', async () => {
        // Remove qualquer assignment existente para evitar conflito de UNIQUE
        await pgPool.query(
            `DELETE FROM consultant_assignments
             WHERE consultant_id = $1 AND tenant_org_id = $2`,
            [CONSULTANT_ID, ORG_ID]
        );

        // Insere assignment já revogado
        const { rows } = await pgPool.query(
            `INSERT INTO consultant_assignments
             (consultant_id, tenant_org_id, consultant_org_id, revoked_at)
             VALUES ($1, $2, $3, NOW())
             RETURNING id`,
            [CONSULTANT_ID, ORG_ID, ORG_ID]
        );
        const assignmentId = rows[0].id;

        try {
            const result = await getConsultantAssignment(pgPool, CONSULTANT_ID, ORG_ID);
            // Revoked → WHERE revoked_at IS NULL filtra → retorna null
            expect(result).toBeNull();
        } finally {
            await pgPool.query(
                'DELETE FROM consultant_assignments WHERE id = $1',
                [assignmentId]
            );
        }
    });
});

// ── T4: getConsultantAssignment retorna null para assignment expirado ──────────

describe('T4: getConsultantAssignment — assignment expirado → null (banco real)', () => {
    it('expires_at no passado faz a query retornar null', async () => {
        await pgPool.query(
            `DELETE FROM consultant_assignments
             WHERE consultant_id = $1 AND tenant_org_id = $2`,
            [CONSULTANT_ID, ORG_ID]
        );

        const { rows } = await pgPool.query(
            `INSERT INTO consultant_assignments
             (consultant_id, tenant_org_id, consultant_org_id, expires_at)
             VALUES ($1, $2, $3, '2020-01-01T00:00:00Z')
             RETURNING id`,
            [CONSULTANT_ID, ORG_ID, ORG_ID]
        );
        const assignmentId = rows[0].id;

        try {
            const result = await getConsultantAssignment(pgPool, CONSULTANT_ID, ORG_ID);
            // Expired → WHERE (expires_at IS NULL OR expires_at > NOW()) filtra → retorna null
            expect(result).toBeNull();
        } finally {
            await pgPool.query(
                'DELETE FROM consultant_assignments WHERE id = $1',
                [assignmentId]
            );
        }
    });
});

// ── T5: GET summary retorna 200 com assignment ativo ─────────────────────────

describe('T5: GET /v1/consultant/tenants/:id/summary com assignment ativo → 200', () => {
    it('assignment ativo e não expirado retorna 200 com dados do tenant', async () => {
        await pgPool.query(
            `DELETE FROM consultant_assignments
             WHERE consultant_id = $1 AND tenant_org_id = $2`,
            [CONSULTANT_ID, ORG_ID]
        );

        const futureDate = new Date(Date.now() + 86_400_000).toISOString(); // +1 dia
        const { rows } = await pgPool.query(
            `INSERT INTO consultant_assignments
             (consultant_id, tenant_org_id, consultant_org_id, role_in_tenant, expires_at)
             VALUES ($1, $2, $3, 'advisor', $4)
             RETURNING id`,
            [CONSULTANT_ID, ORG_ID, ORG_ID, futureDate]
        );
        const assignmentId = rows[0].id;

        try {
            const res = await app.inject({
                method: 'GET',
                url:    `/v1/consultant/tenants/${ORG_ID}/summary`,
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body);
            expect(body.organization).toBeTruthy();
            expect(body.assistants).toBeTruthy();
            expect(typeof body.pendingApprovals).toBe('number');
            expect(typeof body.violationsLast7Days).toBe('number');
            expect(body.consultantRole).toBe('advisor');
        } finally {
            await pgPool.query(
                'DELETE FROM consultant_assignments WHERE id = $1',
                [assignmentId]
            );
        }
    });
});

// ── T6: logConsultantAction persiste no banco e é consultável ─────────────────

describe('T6: logConsultantAction persiste entrada no banco real', () => {
    it('INSERT em consultant_audit_log é visível via SELECT', async () => {
        const uniqueAction = `EFIX_T6_TEST_${Date.now()}`;

        await logConsultantAction(
            pgPool,
            CONSULTANT_ID,
            ORG_ID,
            uniqueAction,
            { source: 'efix-test' },
            'test_resource',
            'efix-resource-id'
        );

        const result = await pgPool.query(
            `SELECT id, action, resource_type, metadata
             FROM consultant_audit_log
             WHERE consultant_id = $1
               AND tenant_org_id = $2
               AND action = $3
             ORDER BY created_at DESC
             LIMIT 1`,
            [CONSULTANT_ID, ORG_ID, uniqueAction]
        );

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].action).toBe(uniqueAction);
        expect(result.rows[0].resource_type).toBe('test_resource');
        // Dados persistidos — imutáveis, não há cleanup (por design)
    });
});

// ── T7: consultant_audit_log — trigger de imutabilidade real ─────────────────

describe('T7: consultant_audit_log UPDATE dispara trigger real', () => {
    it('UPDATE em linha existente lança "é imutável" (trigger real)', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            const { rows } = await client.query(
                `INSERT INTO consultant_audit_log (consultant_id, tenant_org_id, action)
                 VALUES ($1, $2, 'EFIX_T7_IMMUTABILITY_TRIGGER')
                 RETURNING id`,
                [CONSULTANT_ID, ORG_ID]
            );
            const id = rows[0].id;

            await expect(
                client.query(
                    `UPDATE consultant_audit_log SET action = 'TAMPERED' WHERE id = $1`,
                    [id]
                )
            ).rejects.toThrow(/imut[aá]vel/i);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T8: getConsultantPortfolio retorna estrutura correta ──────────────────────

describe('T8: getConsultantPortfolio valida estrutura de retorno (banco real)', () => {
    it('retorna array (possivelmente vazio) com shape { orgId, orgName, role, assignedAt }', async () => {
        const portfolio = await getConsultantPortfolio(pgPool, CONSULTANT_ID);

        expect(Array.isArray(portfolio)).toBe(true);

        // Se houver assignments, cada item deve ter a estrutura correta
        for (const item of portfolio) {
            expect(typeof item.orgId).toBe('string');
            expect(typeof item.orgName).toBe('string');
            expect(typeof item.role).toBe('string');
            expect(item.assignedAt).toBeInstanceOf(Date);
        }
    });
});
