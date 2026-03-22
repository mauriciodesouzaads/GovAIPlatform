/**
 * Shield Core Routes — Detection Foundation
 *
 * Rotas admin para ingestão, processamento e gestão de findings do Shield.
 * Registradas sob /v1/admin/shield/*.
 *
 * Roles permitidos:
 *   - admin, auditor, dpo: leitura de findings
 *   - admin: ingestão, processamento, acknowledge
 *   - admin: promote (requer capacidade de publicação)
 *
 * Nota: collectors corporativos reais (M365, Google, DNS, browser extension)
 * ficam para sprint futura. Ver ADR-003.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    recordShieldObservation,
    processShieldObservations,
    generateShieldFindings,
    acknowledgeShieldFinding,
    promoteShieldFindingToCatalog,
    listShieldFindings,
} from '../lib/shield';

export async function shieldRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;

    // ── POST /v1/admin/shield/observations — ingestão manual ─────────────────
    fastify.post('/v1/admin/shield/observations', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const {
            orgId, sourceType, toolName, userIdentifier,
            departmentHint, observedAt, rawData,
        } = request.body as any;

        if (!orgId || !sourceType || !toolName || !observedAt) {
            return reply.status(400).send({ error: 'orgId, sourceType, toolName e observedAt são obrigatórios.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [orgId]
            );
            const obs = await recordShieldObservation(client, {
                orgId, sourceType, toolName,
                userIdentifier: userIdentifier ?? null,
                departmentHint: departmentHint ?? null,
                observedAt,
                rawData: rawData ?? {},
            });
            return reply.status(201).send({ id: obs.id, toolNameNormalized: obs });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/shield/process — processar observações pendentes ───────
    fastify.post('/v1/admin/shield/process', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId, limit } = request.body as any;

        if (!orgId) {
            return reply.status(400).send({ error: 'orgId é obrigatório.' });
        }

        const result = await processShieldObservations(pgPool, orgId, limit ?? 500);
        return reply.send(result);
    });

    // ── POST /v1/admin/shield/findings/generate — gerar findings ─────────────
    fastify.post('/v1/admin/shield/findings/generate', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId } = request.body as any;

        if (!orgId) {
            return reply.status(400).send({ error: 'orgId é obrigatório.' });
        }

        const result = await generateShieldFindings(pgPool, orgId);
        return reply.send(result);
    });

    // ── GET /v1/admin/shield/findings — listar findings ──────────────────────
    fastify.get('/v1/admin/shield/findings', {
        preHandler: requireRole(['admin', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId, status, severity, toolName, limit } = request.query as any;

        if (!orgId) {
            return reply.status(400).send({ error: 'orgId é obrigatório.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [orgId]
            );
            const findings = await listShieldFindings(client, {
                orgId,
                status:   status   ?? undefined,
                severity: severity ?? undefined,
                toolName: toolName ?? undefined,
                limit:    limit ? parseInt(limit, 10) : 50,
            });
            return reply.send({ findings, total: findings.length });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/shield/findings/:id/acknowledge ────────────────────────
    fastify.post('/v1/admin/shield/findings/:id/acknowledge', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.user ?? {};

        if (!userId) {
            return reply.status(401).send({ error: 'Usuário não autenticado.' });
        }

        const client = await pgPool.connect();
        try {
            // Buscar org do finding (sem RLS — operação de controle admin)
            const findingRow = await client.query(
                'SELECT org_id FROM shield_findings WHERE id = $1',
                [id]
            );
            if (findingRow.rows.length === 0) {
                return reply.status(404).send({ error: 'Finding não encontrado.' });
            }
            const orgId = findingRow.rows[0].org_id as string;

            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [orgId]
            );
            await acknowledgeShieldFinding(client, id, userId);
            return reply.send({ success: true, findingId: id });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/shield/findings/:id/promote ────────────────────────────
    fastify.post('/v1/admin/shield/findings/:id/promote', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.user ?? {};
        const { assistantName, category } = (request.body as any) ?? {};

        if (!userId) {
            return reply.status(401).send({ error: 'Usuário não autenticado.' });
        }

        const result = await promoteShieldFindingToCatalog(
            pgPool, id, userId, { assistantName, category }
        );
        return reply.status(201).send(result);
    });
}
