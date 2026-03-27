/**
 * Shield Consultant Routes — Cross-Tenant Read-Only Views
 *
 * Rotas do consultant plane para leitura de postura e findings Shield.
 * Registradas sob /v1/consultant/tenants/:tenantOrgId/shield/*.
 *
 * Segurança:
 *   1. JWT válido com role admin ou operator (requireRole)
 *   2. Assignment ativo em consultant_assignments → 403 rigoroso se ausente
 *
 * Nota: testa rota real + banco real + autorização de domínio via
 * getConsultantAssignment. Não testa emissão/validação de JWT.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    listShieldPostureForConsultant,
    listShieldFindings,
    listShieldFindingActions,
} from '../lib/shield';
import {
    getConsultantAssignment,
    logConsultantAction,
} from '../lib/consultant-auth';

export async function shieldConsultantRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;

    // ── GET /v1/consultant/tenants/:tenantOrgId/shield/posture ────────────────
    fastify.get('/v1/consultant/tenants/:tenantOrgId/shield/posture', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { tenantOrgId } = request.params as { tenantOrgId: string };
        const { userId } = request.user ?? {};
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });

        const assignment = await getConsultantAssignment(pgPool, userId, tenantOrgId);
        if (!assignment) {
            return reply.status(403).send({ error: 'Acesso negado. Sem atribuição ativa para este tenant.' });
        }

        const posture = await listShieldPostureForConsultant(pgPool, tenantOrgId);
        await logConsultantAction(pgPool, userId, tenantOrgId, 'SHIELD_POSTURE_VIEW', {
            openFindings: posture.openFindings,
        });
        return reply.send(posture);
    });

    // ── GET /v1/consultant/tenants/:tenantOrgId/shield/findings ──────────────
    fastify.get('/v1/consultant/tenants/:tenantOrgId/shield/findings', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { tenantOrgId } = request.params as { tenantOrgId: string };
        const { userId } = request.user ?? {};
        const { status, severity, limit } = request.query as any;
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });

        const assignment = await getConsultantAssignment(pgPool, userId, tenantOrgId);
        if (!assignment) {
            return reply.status(403).send({ error: 'Acesso negado. Sem atribuição ativa para este tenant.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [tenantOrgId]
            );
            const findings = await listShieldFindings(client, {
                orgId:    tenantOrgId,
                status:   status   ?? undefined,
                severity: severity ?? undefined,
                limit:    limit ? parseInt(limit, 10) : 50,
            });
            await logConsultantAction(pgPool, userId, tenantOrgId, 'SHIELD_FINDINGS_VIEW', {
                count: findings.length,
            });
            return reply.send({ findings, total: findings.length });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/consultant/tenants/:tenantOrgId/shield/findings/:id/actions ──
    fastify.get('/v1/consultant/tenants/:tenantOrgId/shield/findings/:id/actions', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { tenantOrgId, id } = request.params as { tenantOrgId: string; id: string };
        const { userId } = request.user ?? {};
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });

        const assignment = await getConsultantAssignment(pgPool, userId, tenantOrgId);
        if (!assignment) {
            return reply.status(403).send({ error: 'Acesso negado. Sem atribuição ativa para este tenant.' });
        }

        const actions = await listShieldFindingActions(pgPool, tenantOrgId, id);
        return reply.send({ actions, total: actions.length });
    });
}
