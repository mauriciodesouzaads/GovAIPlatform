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
    acceptRisk,
    dismissFinding,
    resolveFinding,
    reopenFinding,
    promoteShieldFindingToCatalog,
    listShieldFindings,
    generateExecutivePosture,
    dedupeFindings,
    syncShieldToolsWithCatalog,
    assignShieldFindingOwner,
    listShieldFindingActions,
    listShieldPostureForConsultant,
} from '../lib/shield';
import {
    getConsultantAssignment,
    logConsultantAction,
} from '../lib/consultant-auth';
import { collectMicrosoftOAuthGrants } from '../lib/shield-oauth-collector';
import { generateExecutiveReport } from '../lib/shield-report';
import {
    storeGoogleCollector,
    storeGoogleToken,
    fetchGoogleObservations,
    ingestGoogleObservations,
} from '../lib/shield-google-collector';
import {
    storeNetworkCollector,
    ingestNetworkBatch,
} from '../lib/shield-network-collector';

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

    // ── POST /v1/admin/shield/findings/:id/accept-risk ───────────────────────
    fastify.post('/v1/admin/shield/findings/:id/accept-risk', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.user ?? {};
        const { note } = (request.body as any) ?? {};
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });
        if (!note?.trim()) return reply.status(400).send({ error: 'Justificativa obrigatória (note).' });
        await acceptRisk(pgPool, id, userId, note);
        return reply.send({ success: true, findingId: id });
    });

    // ── POST /v1/admin/shield/findings/:id/dismiss ────────────────────────────
    fastify.post('/v1/admin/shield/findings/:id/dismiss', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.user ?? {};
        const { reason, note } = (request.body as any) ?? {};
        const dismissReason = reason ?? note;  // aceita ambos os nomes de campo
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });
        if (!dismissReason?.trim()) return reply.status(400).send({ error: 'Motivo obrigatório (reason).' });
        await dismissFinding(pgPool, id, userId, dismissReason);
        return reply.send({ success: true, findingId: id });
    });

    // ── POST /v1/admin/shield/findings/:id/resolve ────────────────────────────
    fastify.post('/v1/admin/shield/findings/:id/resolve', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.user ?? {};
        const { note } = (request.body as any) ?? {};
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });
        await resolveFinding(pgPool, id, userId, note);
        return reply.send({ success: true, findingId: id });
    });

    // ── POST /v1/admin/shield/findings/:id/reopen ─────────────────────────────
    fastify.post('/v1/admin/shield/findings/:id/reopen', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.user ?? {};
        const { note } = (request.body as any) ?? {};
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });
        await reopenFinding(pgPool, id, userId, note);
        return reply.send({ success: true, findingId: id });
    });

    // ── GET /v1/admin/shield/posture — snapshot mais recente ──────────────────
    fastify.get('/v1/admin/shield/posture', {
        preHandler: requireRole(['admin', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.query as any;
        if (!orgId) return reply.status(400).send({ error: 'orgId obrigatório.' });

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            const snap = await client.query(
                `SELECT * FROM shield_posture_snapshots
                 WHERE org_id = $1
                 ORDER BY generated_at DESC LIMIT 1`,
                [orgId]
            );
            return reply.send(snap.rows[0] ?? { message: 'Nenhum snapshot disponível.' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/shield/posture/generate — gerar novo snapshot ──────────
    fastify.post('/v1/admin/shield/posture/generate', {
        preHandler: requireRole(['admin', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.body as any;
        const { userId } = request.user ?? {};
        if (!orgId) return reply.status(400).send({ error: 'orgId obrigatório.' });
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });

        const posture = await generateExecutivePosture(pgPool, orgId, userId);
        return reply.status(201).send(posture);
    });

    // ── GET /v1/admin/shield/posture/history — histórico de snapshots ─────────
    fastify.get('/v1/admin/shield/posture/history', {
        preHandler: requireRole(['admin', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId, limit } = request.query as any;
        if (!orgId) return reply.status(400).send({ error: 'orgId obrigatório.' });

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            const snaps = await client.query(
                `SELECT id, generated_at, summary_score, open_findings,
                        promoted_findings, accepted_risk, top_tools
                 FROM shield_posture_snapshots
                 WHERE org_id = $1
                 ORDER BY generated_at DESC
                 LIMIT $2`,
                [orgId, Math.min(parseInt(limit ?? '10', 10), 50)]
            );
            return reply.send({ history: snaps.rows });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/shield/google/collectors — configurar coletor Google ───
    fastify.post('/v1/admin/shield/google/collectors', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId, collectorName, adminEmail, scopes } = (request.body as any) ?? {};
        if (!orgId || !collectorName || !adminEmail)
            return reply.status(400).send({ error: 'orgId, collectorName e adminEmail obrigatórios.' });

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            const collector = await storeGoogleCollector(pgPool, {
                orgId, collectorName, adminEmail, scopes: scopes ?? [],
            });
            return reply.status(201).send(collector);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/shield/google/collectors/:id/token ─────────────────────
    // Armazena token OAuth criptografado para o coletor Google.
    // O caller é responsável pela criptografia do token antes de enviar.
    fastify.post('/v1/admin/shield/google/collectors/:id/token', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id: collectorId } = request.params as { id: string };
        const { orgId, accessTokenEncrypted, refreshTokenEncrypted, tokenHash, expiresAt } =
            (request.body as any) ?? {};

        if (!orgId || !accessTokenEncrypted || !tokenHash)
            return reply.status(400).send({ error: 'orgId, accessTokenEncrypted e tokenHash obrigatórios.' });

        const token = await storeGoogleToken(
            pgPool, collectorId, orgId,
            accessTokenEncrypted, refreshTokenEncrypted ?? null,
            tokenHash, expiresAt ? new Date(expiresAt) : null
        );
        return reply.status(201).send({ id: token.id, tokenHash: token.tokenHash });
    });

    // ── POST /v1/admin/shield/google/collectors/:id/fetch ─────────────────────
    // Dispara coleta manual via Google Admin SDK Reports API.
    // accessToken: token OAuth válido para a API (resolvido externamente).
    fastify.post('/v1/admin/shield/google/collectors/:id/fetch', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id: collectorId } = request.params as { id: string };
        const { orgId, accessToken, daysBack } = (request.body as any) ?? {};

        if (!orgId || !accessToken)
            return reply.status(400).send({ error: 'orgId e accessToken obrigatórios.' });

        const { activities, errors: fetchErrors } =
            await fetchGoogleObservations(accessToken, daysBack ?? 7);

        const { ingested, errors: ingestErrors } =
            await ingestGoogleObservations(pgPool, orgId, collectorId, activities);

        return reply.send({
            fetched:  activities.length,
            ingested,
            errors:   [...fetchErrors, ...ingestErrors],
        });
    });

    // ── POST /v1/admin/shield/collectors — configurar coletor OAuth ───────────
    fastify.post('/v1/admin/shield/collectors', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId, provider, externalTenantId, credentialsRef } =
            (request.body as any) ?? {};

        if (!orgId || !provider) {
            return reply.status(400).send({ error: 'orgId e provider são obrigatórios.' });
        }
        if (!['microsoft', 'google'].includes(provider)) {
            return reply.status(400).send({ error: "provider deve ser 'microsoft' ou 'google'." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            const result = await client.query(
                `INSERT INTO shield_oauth_collectors
                 (org_id, provider, external_tenant_id, credentials_ref, collection_enabled)
                 VALUES ($1, $2, $3, $4, false)
                 ON CONFLICT (org_id, provider)
                 DO UPDATE SET
                   external_tenant_id = EXCLUDED.external_tenant_id,
                   credentials_ref    = COALESCE(EXCLUDED.credentials_ref, shield_oauth_collectors.credentials_ref)
                 RETURNING id, org_id, provider, collection_enabled, created_at`,
                [orgId, provider, externalTenantId ?? null, credentialsRef ?? null]
            );
            return reply.status(201).send(result.rows[0]);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/shield/collectors/:id/trigger — coleta manual ──────────
    // Dispara coleta imediata para testes e desenvolvimento.
    // Em produção, usar worker BullMQ para coleta assíncrona.
    fastify.post('/v1/admin/shield/collectors/:id/trigger', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id: collectorId } = request.params as { id: string };
        const { accessToken } = (request.body as any) ?? {};

        if (!accessToken) {
            return reply.status(400).send({ error: 'accessToken é obrigatório.' });
        }

        // Buscar configuração do coletor
        const collectorRow = await pgPool.query(
            `SELECT id, org_id, provider FROM shield_oauth_collectors WHERE id = $1`,
            [collectorId]
        );
        if (collectorRow.rows.length === 0) {
            return reply.status(404).send({ error: 'Coletor não encontrado.' });
        }

        const { org_id: orgId, provider } = collectorRow.rows[0];

        if (provider !== 'microsoft') {
            return reply.status(400).send({ error: 'Apenas Microsoft suportado nesta sprint.' });
        }

        const result = await collectMicrosoftOAuthGrants(
            pgPool, orgId, collectorId, accessToken
        );
        return reply.send(result);
    });

    // ── GET /v1/admin/shield/reports/executive — relatório executivo ──────────
    fastify.get('/v1/admin/shield/reports/executive', {
        preHandler: requireRole(['admin', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.query as any;
        const { userId } = request.user ?? {};

        if (!orgId) {
            return reply.status(400).send({ error: 'orgId é obrigatório.' });
        }
        if (!userId) {
            return reply.status(401).send({ error: 'Usuário não autenticado.' });
        }

        const report = await generateExecutiveReport(pgPool, orgId, userId);
        return reply.send(report);
    });

    // ── POST /v1/admin/shield/network/collectors — registrar collector ────────
    fastify.post('/v1/admin/shield/network/collectors', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId, collectorName, sourceKind } = request.body as any;

        if (!orgId || !collectorName || !sourceKind) {
            return reply.status(400).send({ error: 'orgId, collectorName e sourceKind são obrigatórios.' });
        }
        if (!['proxy', 'swg', 'network'].includes(sourceKind)) {
            return reply.status(400).send({ error: 'sourceKind deve ser proxy|swg|network.' });
        }

        const collector = await storeNetworkCollector(pgPool, { orgId, collectorName, sourceKind });
        return reply.status(201).send(collector);
    });

    // ── POST /v1/admin/shield/network/collectors/:id/ingest — ingerir lote ───
    fastify.post('/v1/admin/shield/network/collectors/:id/ingest', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const collectorId = (request.params as any).id as string;
        const { orgId, events } = request.body as any;

        if (!orgId || !Array.isArray(events)) {
            return reply.status(400).send({ error: 'orgId e events[] são obrigatórios.' });
        }
        if (events.length === 0) {
            return reply.status(400).send({ error: 'events[] não pode ser vazio.' });
        }

        const result = await ingestNetworkBatch(pgPool, orgId, collectorId, events);
        return reply.send(result);
    });

    // ── POST /v1/admin/shield/dedupe — deduplicar findings ───────────────────
    fastify.post('/v1/admin/shield/dedupe', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId } = request.body as any;
        if (!orgId) return reply.status(400).send({ error: 'orgId é obrigatório.' });

        const result = await dedupeFindings(pgPool, orgId);
        return reply.send(result);
    });

    // ── POST /v1/admin/shield/sync-catalog — sync approval_status ────────────
    fastify.post('/v1/admin/shield/sync-catalog', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId } = request.body as any;
        if (!orgId) return reply.status(400).send({ error: 'orgId é obrigatório.' });

        const result = await syncShieldToolsWithCatalog(pgPool, orgId);
        return reply.send(result);
    });

    // ── POST /v1/admin/shield/findings/:id/assign-owner (Sprint S2) ───────────
    fastify.post('/v1/admin/shield/findings/:id/assign-owner', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.user ?? {};
        const { ownerCandidateHash, note } = (request.body as any) ?? {};
        if (!userId) return reply.status(401).send({ error: 'Não autenticado.' });
        if (!ownerCandidateHash) return reply.status(400).send({ error: 'ownerCandidateHash obrigatório.' });
        await assignShieldFindingOwner(pgPool, id, ownerCandidateHash, userId, note);
        return reply.send({ success: true, findingId: id });
    });

    // ── GET /v1/admin/shield/findings/:id/actions (Sprint S2) ────────────────
    fastify.get('/v1/admin/shield/findings/:id/actions', {
        preHandler: requireRole(['admin', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { id } = request.params as { id: string };
        // Buscar org_id sem RLS (lookup de controle)
        const findingRow = await pgPool.query(
            'SELECT org_id FROM shield_findings WHERE id = $1', [id]
        );
        if (findingRow.rows.length === 0) {
            return reply.status(404).send({ error: 'Finding não encontrado.' });
        }
        const orgId = findingRow.rows[0].org_id as string;
        const actions = await listShieldFindingActions(pgPool, orgId, id);
        return reply.send({ actions, total: actions.length });
    });

    // ── Consultant Shield Views (Sprint S2) ───────────────────────────────────
    //
    // Todas as rotas consultant requerem:
    //   1. Usuário autenticado (userId presente em request.user)
    //   2. Assignment ativo em consultant_assignments → 403 rigoroso se ausente
    //
    // Nota: testa rota real + banco real + autorização de domínio via
    // getConsultantAssignment. Não testa emissão/validação de JWT.

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
