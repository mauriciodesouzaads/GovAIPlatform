/**
 * shield.workflow.test.ts
 *
 * Sprint S2 — Shield Finding Workflow & Consultant Value.
 *
 * T1–T12: Banco real (domain logic, RLS, action log, posture).
 * T13–T17: Rotas reais (Fastify inject real + banco real).
 *
 * NOTA: request.user é injetado via mockRequireRole —
 * testa rota real + banco real + autorização de domínio.
 * NÃO testa emissão/validação de JWT.
 *
 * Excluído da suíte padrão via integrationTestPatterns em vitest.config.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error(
        'shield.workflow.test.ts requer DATABASE_URL. ' +
        'Excluído automaticamente via integrationTestPatterns.'
    );
}

import { Pool } from 'pg';
import Fastify from 'fastify';
import {
    assignShieldFindingOwner,
    acceptRisk,
    dismissFinding,
    resolveFinding,
    reopenFinding,
    listShieldFindingActions,
    listShieldPostureForConsultant,
    generateExecutivePosture,
    promoteShieldFindingToCatalog,
} from '../lib/shield';
import { shieldRoutes } from '../routes/shield.routes';

const pgPool = new Pool({ connectionString: DATABASE_URL });

const ORG_ID         = '00000000-0000-0000-0000-000000000001';
const ACTOR_ID       = '00000000-0000-0000-0000-000000000010';
const CONSULTANT_ID  = '00000000-0000-0000-0000-000000000020';
const NO_ASSIGN_ID   = '00000000-0000-0000-0000-000000000021';

// currentUserId é mutável — permite que T16/T17 testem diferentes usuários
let currentUserId = ACTOR_ID;

function mockRequireRole(_roles: string[]) {
    return async (request: any, _reply: any) => {
        request.user = { userId: currentUserId, orgId: ORG_ID, role: 'admin' };
    };
}

let app: any;

// ── helpers ───────────────────────────────────────────────────────────────────

async function createFinding(toolSuffix: string, status = 'open'): Promise<string> {
    const client = await pgPool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
        );
        const res = await client.query(
            `INSERT INTO shield_findings
             (org_id, tool_name, tool_name_normalized, severity, status, rationale,
              first_seen_at, last_seen_at, observation_count)
             VALUES ($1, $2, $3, 'medium', $4, 'Finding para workflow S2', NOW(), NOW(), 5)
             RETURNING id`,
            [ORG_ID, 'wf-tool-' + toolSuffix, 'wf-tool-' + toolSuffix, status]
        );
        return res.rows[0].id as string;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
    // Garantir org
    await pgPool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [ORG_ID, 'Test Org S2 Workflow']
    );

    // Garantir users (FK em assignments e findings)
    for (const [id, email, role] of [
        [ACTOR_ID,      'actor-s2@test.com',        'admin'],
        [CONSULTANT_ID, 'consultant-s2@test.com',   'operator'],
        [NO_ASSIGN_ID,  'no-assign-s2@test.com',    'operator'],
    ] as const) {
        await pgPool.query(
            `INSERT INTO users (id, email, password_hash, role, org_id)
             VALUES ($1, $2, 'x', $3, $4) ON CONFLICT (id) DO NOTHING`,
            [id, email, role, ORG_ID]
        );
    }

    // Inserir assignment ativo: CONSULTANT_ID → ORG_ID
    await pgPool.query(
        `INSERT INTO consultant_assignments
         (consultant_id, tenant_org_id, role_in_tenant, assigned_at, is_active)
         VALUES ($1, $2, 'viewer', NOW(), true)
         ON CONFLICT DO NOTHING`,
        [CONSULTANT_ID, ORG_ID]
    );
    // NO_ASSIGN_ID não recebe assignment → deve resultar em 403

    // Construir app Fastify com rotas reais
    const fastify = Fastify();
    await shieldRoutes(fastify, { pgPool, requireRole: mockRequireRole });
    await fastify.ready();
    app = fastify;
});

afterAll(async () => {
    await pgPool.query(
        `DELETE FROM shield_findings WHERE org_id = $1 AND tool_name LIKE 'wf-tool-%'`,
        [ORG_ID]
    ).catch(() => {});
    await pgPool.query(
        `DELETE FROM consultant_assignments WHERE consultant_id = $1`,
        [CONSULTANT_ID]
    ).catch(() => {});
    await app.close().catch(() => {});
    await pgPool.end();
});

// ── T1: assignShieldFindingOwner ──────────────────────────────────────────────

describe('T1: assignShieldFindingOwner atualiza finding e cria action log', () => {
    it('owner_assigned_at preenchido + action log assign_owner inserido', async () => {
        const findingId = await createFinding('t1-' + Date.now());
        const ownerHash = 'a'.repeat(64);

        await assignShieldFindingOwner(pgPool, findingId, ownerHash, ACTOR_ID, 'Assigned in T1');

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const finding = await client.query(
                `SELECT owner_candidate_hash, owner_assigned_at, owner_assigned_by,
                        last_action_at
                 FROM shield_findings WHERE id = $1`,
                [findingId]
            );
            expect(finding.rows[0].owner_candidate_hash).toBe(ownerHash);
            expect(finding.rows[0].owner_assigned_at).toBeTruthy();
            expect(finding.rows[0].owner_assigned_by).toBe(ACTOR_ID);
            expect(finding.rows[0].last_action_at).toBeTruthy();

            const action = await client.query(
                `SELECT action_type, actor_user_id, note
                 FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'assign_owner' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
            expect(action.rows[0].actor_user_id).toBe(ACTOR_ID);
            expect(action.rows[0].note).toBe('Assigned in T1');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T2: acceptRisk exige justificativa ────────────────────────────────────────

describe('T2: acceptRisk exige justificativa e cria action log', () => {
    it('lança erro se note vazio', async () => {
        const findingId = await createFinding('t2a-' + Date.now());
        await expect(acceptRisk(pgPool, findingId, ACTOR_ID, '')).rejects.toThrow();
    });

    it('status → accepted_risk + action log + accepted_risk=true (não fecha finding)', async () => {
        const findingId = await createFinding('t2b-' + Date.now());
        await acceptRisk(pgPool, findingId, ACTOR_ID, 'Risco aceito em T2');

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const finding = await client.query(
                `SELECT status, accepted_risk, accepted_risk_note, last_action_at
                 FROM shield_findings WHERE id = $1`,
                [findingId]
            );
            expect(finding.rows[0].status).toBe('accepted_risk');
            expect(finding.rows[0].accepted_risk).toBe(true);
            expect(finding.rows[0].accepted_risk_note).toBe('Risco aceito em T2');
            expect(finding.rows[0].last_action_at).toBeTruthy();

            const action = await client.query(
                `SELECT action_type FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'accept_risk' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T3: dismissFinding exige motivo ───────────────────────────────────────────

describe('T3: dismissFinding exige motivo e cria action log', () => {
    it('lança erro se reason vazio', async () => {
        const findingId = await createFinding('t3a-' + Date.now());
        await expect(dismissFinding(pgPool, findingId, ACTOR_ID, '')).rejects.toThrow();
    });

    it('status → dismissed + dismissed_reason preenchido + action log', async () => {
        const findingId = await createFinding('t3b-' + Date.now());
        await dismissFinding(pgPool, findingId, ACTOR_ID, 'Falso positivo T3');

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const finding = await client.query(
                `SELECT status, dismissed_reason, dismissed_at, last_action_at
                 FROM shield_findings WHERE id = $1`,
                [findingId]
            );
            expect(finding.rows[0].status).toBe('dismissed');
            expect(finding.rows[0].dismissed_reason).toBe('Falso positivo T3');
            expect(finding.rows[0].dismissed_at).toBeTruthy();
            expect(finding.rows[0].last_action_at).toBeTruthy();

            const action = await client.query(
                `SELECT action_type FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'dismiss' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T4: resolveFinding ────────────────────────────────────────────────────────

describe('T4: resolveFinding → status=resolved + action log', () => {
    it('finding resolvido + action log resolve + last_action_at atualizado', async () => {
        const findingId = await createFinding('t4-' + Date.now());
        await resolveFinding(pgPool, findingId, ACTOR_ID, 'Resolvido em T4');

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const finding = await client.query(
                `SELECT status, resolved_at, last_action_at FROM shield_findings WHERE id = $1`,
                [findingId]
            );
            expect(finding.rows[0].status).toBe('resolved');
            expect(finding.rows[0].resolved_at).toBeTruthy();
            expect(finding.rows[0].last_action_at).toBeTruthy();

            const action = await client.query(
                `SELECT action_type FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'resolve' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T5: reopenFinding ─────────────────────────────────────────────────────────

describe('T5: reopenFinding reabre finding + action log', () => {
    it('finding dismissed → open + reopened_at + action log reopen', async () => {
        const findingId = await createFinding('t5-' + Date.now(), 'dismissed');

        await reopenFinding(pgPool, findingId, ACTOR_ID, 'Reaberto em T5');

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const finding = await client.query(
                `SELECT status, reopened_at, reopened_by, last_action_at
                 FROM shield_findings WHERE id = $1`,
                [findingId]
            );
            expect(finding.rows[0].status).toBe('open');
            expect(finding.rows[0].reopened_at).toBeTruthy();
            expect(finding.rows[0].reopened_by).toBe(ACTOR_ID);
            expect(finding.rows[0].last_action_at).toBeTruthy();

            const action = await client.query(
                `SELECT action_type FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'reopen' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T6: promoteShieldFindingToCatalog continua funcional ─────────────────────

describe('T6: promoteShieldFindingToCatalog funciona após migração S2', () => {
    it('finding promovido + assistant draft criado + action log promote', async () => {
        const findingId = await createFinding('t6-' + Date.now());
        const result = await promoteShieldFindingToCatalog(pgPool, findingId, ACTOR_ID);

        expect(result.findingId).toBe(findingId);
        expect(result.assistantId).toBeTruthy();

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const finding = await client.query(
                `SELECT status FROM shield_findings WHERE id = $1`,
                [findingId]
            );
            expect(finding.rows[0].status).toBe('promoted');

            const action = await client.query(
                `SELECT action_type FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'promote' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T7: last_action_at atualizado em cada ação ───────────────────────────────

describe('T7: last_action_at atualizado corretamente', () => {
    it('last_action_at muda após assign-owner', async () => {
        const findingId = await createFinding('t7-' + Date.now());

        // Verificar que last_action_at é NULL antes
        const client = await pgPool.connect();
        let before: Date | null = null;
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const r = await client.query(
                `SELECT last_action_at FROM shield_findings WHERE id = $1`, [findingId]
            );
            before = r.rows[0].last_action_at;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
        expect(before).toBeNull();

        // Executar ação
        await assignShieldFindingOwner(pgPool, findingId, 'b'.repeat(64), ACTOR_ID);

        const client2 = await pgPool.connect();
        try {
            await client2.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const r = await client2.query(
                `SELECT last_action_at FROM shield_findings WHERE id = $1`, [findingId]
            );
            expect(r.rows[0].last_action_at).toBeTruthy();
        } finally {
            await client2.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client2.release();
        }
    });
});

// ── T8: accepted_risk não fecha finding implicitamente ────────────────────────

describe('T8: accepted_risk não fecha finding (status ≠ resolved/dismissed)', () => {
    it('status permanece accepted_risk após acceptRisk', async () => {
        const findingId = await createFinding('t8-' + Date.now());
        await acceptRisk(pgPool, findingId, ACTOR_ID, 'Aceito em T8 — risco documentado');

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const finding = await client.query(
                `SELECT status FROM shield_findings WHERE id = $1`, [findingId]
            );
            expect(finding.rows[0].status).toBe('accepted_risk');
            // NÃO deve ser resolved nem dismissed
            expect(finding.rows[0].status).not.toBe('resolved');
            expect(finding.rows[0].status).not.toBe('dismissed');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T9: tenant sem assignment → 403 nas views consultant Shield ───────────────

describe('T9: consultant sem assignment → 403 nas rotas consultant Shield', () => {
    it('GET /consultant/tenants/:id/shield/findings → 403 sem assignment', async () => {
        currentUserId = NO_ASSIGN_ID;
        try {
            const res = await app.inject({
                method: 'GET',
                url:    `/v1/consultant/tenants/${ORG_ID}/shield/findings`,
            });
            expect(res.statusCode).toBe(403);
        } finally {
            currentUserId = ACTOR_ID;
        }
    });

    it('GET /consultant/tenants/:id/shield/posture → 403 sem assignment', async () => {
        currentUserId = NO_ASSIGN_ID;
        try {
            const res = await app.inject({
                method: 'GET',
                url:    `/v1/consultant/tenants/${ORG_ID}/shield/posture`,
            });
            expect(res.statusCode).toBe(403);
        } finally {
            currentUserId = ACTOR_ID;
        }
    });
});

// ── T10: consultant com assignment vê apenas tenant autorizado ────────────────

describe('T10: consultant com assignment vê tenant autorizado', () => {
    it('GET /consultant/tenants/:id/shield/findings → 200 com assignment', async () => {
        currentUserId = CONSULTANT_ID;
        try {
            const res = await app.inject({
                method: 'GET',
                url:    `/v1/consultant/tenants/${ORG_ID}/shield/findings`,
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body);
            expect(Array.isArray(body.findings)).toBe(true);
        } finally {
            currentUserId = ACTOR_ID;
        }
    });
});

// ── T11: posture snapshot persiste unresolved_critical ────────────────────────

describe('T11: posture snapshot persiste dados úteis do backlog atual', () => {
    it('generateExecutivePosture retorna unresolvedCritical e persiste no banco', async () => {
        const snapshot = await generateExecutivePosture(pgPool, ORG_ID, ACTOR_ID);

        expect(typeof snapshot.unresolvedCritical).toBe('number');
        expect(snapshot.unresolvedCritical).toBeGreaterThanOrEqual(0);
        expect(typeof snapshot.openFindings).toBe('number');
        expect(Array.isArray(snapshot.topTools)).toBe(true);

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const row = await client.query(
                `SELECT unresolved_critical FROM shield_posture_snapshots
                 WHERE org_id = $1 ORDER BY generated_at DESC LIMIT 1`,
                [ORG_ID]
            );
            expect(row.rows).toHaveLength(1);
            expect(typeof row.rows[0].unresolved_critical).toBe('number');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T12: RLS — shield_finding_actions isolado por org ────────────────────────

describe('T12: RLS correta em shield_finding_actions', () => {
    it('org errada vê 0 actions da org correta', async () => {
        const WRONG_ORG = '00000000-0000-0000-0000-000000000099';
        const findingId = await createFinding('t12-' + Date.now());
        await assignShieldFindingOwner(pgPool, findingId, 'c'.repeat(64), ACTOR_ID);

        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [WRONG_ORG]
            );
            const result = await client.query(
                `SELECT COUNT(*) AS cnt FROM shield_finding_actions
                 WHERE finding_id = $1`,
                [findingId]
            );
            expect(Number(result.rows[0].cnt)).toBe(0);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T13: POST /accept-risk → 200 com note ────────────────────────────────────

describe('T13: POST /v1/admin/shield/findings/:id/accept-risk → 200', () => {
    it('endpoint aceita risco com justificativa', async () => {
        const findingId = await createFinding('t13-' + Date.now());
        const res = await app.inject({
            method:  'POST',
            url:     `/v1/admin/shield/findings/${findingId}/accept-risk`,
            payload: { note: 'Aceito via T13 — risk documented' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).findingId).toBe(findingId);
    });

    it('endpoint retorna 400 sem note', async () => {
        const findingId = await createFinding('t13b-' + Date.now());
        const res = await app.inject({
            method:  'POST',
            url:     `/v1/admin/shield/findings/${findingId}/accept-risk`,
            payload: {},
        });
        expect(res.statusCode).toBe(400);
    });
});

// ── T14: POST /dismiss → 200 com reason ──────────────────────────────────────

describe('T14: POST /v1/admin/shield/findings/:id/dismiss → 200', () => {
    it('endpoint dismiss com motivo', async () => {
        const findingId = await createFinding('t14-' + Date.now());
        const res = await app.inject({
            method:  'POST',
            url:     `/v1/admin/shield/findings/${findingId}/dismiss`,
            payload: { reason: 'Falso positivo confirmado em T14' },
        });
        expect(res.statusCode).toBe(200);
    });

    it('endpoint retorna 400 sem reason', async () => {
        const findingId = await createFinding('t14b-' + Date.now());
        const res = await app.inject({
            method:  'POST',
            url:     `/v1/admin/shield/findings/${findingId}/dismiss`,
            payload: {},
        });
        expect(res.statusCode).toBe(400);
    });
});

// ── T15: GET /findings/:id/actions → 200 com array ───────────────────────────

describe('T15: GET /v1/admin/shield/findings/:id/actions → 200', () => {
    it('retorna array de actions para finding com histórico', async () => {
        const findingId = await createFinding('t15-' + Date.now());
        await assignShieldFindingOwner(pgPool, findingId, 'd'.repeat(64), ACTOR_ID, 'T15 owner');

        const res = await app.inject({
            method: 'GET',
            url:    `/v1/admin/shield/findings/${findingId}/actions`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.actions)).toBe(true);
        expect(body.actions.length).toBeGreaterThan(0);
        expect(body.actions[0].action_type).toBe('assign_owner');
    });
});

// ── T16: GET consultant/findings → 200 quando assignment existe ───────────────

describe('T16: GET /consultant/tenants/:id/shield/findings → 200 com assignment', () => {
    it('consultant com assignment vê findings do tenant', async () => {
        currentUserId = CONSULTANT_ID;
        try {
            const res = await app.inject({
                method: 'GET',
                url:    `/v1/consultant/tenants/${ORG_ID}/shield/findings`,
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body);
            expect(Array.isArray(body.findings)).toBe(true);
            expect(typeof body.total).toBe('number');
        } finally {
            currentUserId = ACTOR_ID;
        }
    });
});

// ── T17: GET consultant/findings → 403 sem assignment ────────────────────────

describe('T17: GET /consultant/tenants/:id/shield/findings → 403 sem assignment', () => {
    it('usuário sem assignment recebe 403', async () => {
        currentUserId = NO_ASSIGN_ID;
        try {
            const res = await app.inject({
                method: 'GET',
                url:    `/v1/consultant/tenants/${ORG_ID}/shield/findings`,
            });
            expect(res.statusCode).toBe(403);
            const body = JSON.parse(res.body);
            expect(body.error).toMatch(/negado|assignment/i);
        } finally {
            currentUserId = ACTOR_ID;
        }
    });
});
