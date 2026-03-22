/**
 * Shield Core Tests — Sprint F
 *
 * Testa rota real + banco real + autorização de domínio.
 * NÃO testa emissão/validação de JWT.
 *
 * O preHandler injeta request.user diretamente para isolar a lógica de
 * negócio do Shield sem depender do fluxo de autenticação JWT.
 *
 * Requer DATABASE_URL configurado. Excluído da suíte padrão via
 * integrationTestPatterns em vitest.config.ts.
 *
 * Execute:
 *   DATABASE_URL=postgresql://... npx vitest run src/__tests__/shield.core.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    normalizeToolName,
    hashUserIdentifier,
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
} from '../lib/shield';
import { shieldRoutes } from '../routes/shield.routes';

// ── Configuração ──────────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    throw new Error(
        'DATABASE_URL é obrigatório para os testes do Shield Core.\n' +
        'Execute: DATABASE_URL=postgresql://... npx vitest run src/__tests__/shield.core.test.ts'
    );
}

const ORG_ID        = '00000000-0000-0000-0000-000000000001';
const ACTOR_ID      = '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab'; // admin@orga.com
const WRONG_ORG_ID  = '00000000-0000-0000-0000-000000000099';
const TEST_TOOL     = 'Shield-Test-ChatGPT-' + Date.now(); // único por execução

let pgPool: Pool;
let app: FastifyInstance;

const mockRequireRole = (_roles: string[]) => async (request: any) => {
    request.user = { userId: ACTOR_ID, orgId: ORG_ID, role: 'admin' };
};

beforeAll(async () => {
    pgPool = new Pool({ connectionString: dbUrl });

    app = Fastify({ logger: false });
    await app.register(shieldRoutes, { pgPool, requireRole: mockRequireRole });
    await app.ready();
});

afterAll(async () => {
    // Limpar dados de teste (não imutáveis)
    const client = await pgPool.connect();
    try {
        const normalized = normalizeToolName(TEST_TOOL);
        // Limpar em ordem de dependência (FKs)
        await client.query(
            `DELETE FROM shield_finding_actions
             WHERE finding_id IN (
               SELECT id FROM shield_findings
               WHERE org_id = $1 AND (tool_name_normalized LIKE $2 OR tool_name_normalized = 'rls-test-tool')
             )`,
            [ORG_ID, normalized.replace(/-\d+$/, '') + '%']
        );
        await client.query(
            `DELETE FROM shield_posture_snapshots WHERE org_id = $1`, [ORG_ID]
        );
        await client.query(
            `DELETE FROM shield_findings WHERE org_id = $1
             AND (tool_name_normalized LIKE $2 OR tool_name_normalized = 'rls-test-tool'
                  OR tool_name_normalized LIKE 'workflow-test%')`,
            [ORG_ID, normalized.replace(/-\d+$/, '') + '%']
        );
        await client.query(
            `DELETE FROM shield_rollups WHERE org_id = $1 AND tool_name_normalized LIKE $2`,
            [ORG_ID, normalized.replace(/-\d+$/, '') + '%']
        );
        await client.query(
            `DELETE FROM shield_observations_raw WHERE org_id = $1 AND tool_name_normalized LIKE $2`,
            [ORG_ID, normalized.replace(/-\d+$/, '') + '%']
        );
        await client.query(
            `DELETE FROM shield_tools WHERE org_id = $1 AND tool_name_normalized LIKE $2`,
            [ORG_ID, normalized.replace(/-\d+$/, '') + '%']
        );
    } finally {
        client.release();
    }
    await app.close();
    await pgPool.end();
});

// ── T1: normalizeToolName ─────────────────────────────────────────────────────

describe('T1: normalizeToolName', () => {
    it("' ChatGPT  ' → 'chatgpt'", () => {
        expect(normalizeToolName(' ChatGPT  ')).toBe('chatgpt');
    });

    it("'Microsoft  Copilot' colapsa espaços duplos", () => {
        expect(normalizeToolName('Microsoft  Copilot')).toBe('microsoft copilot');
    });

    it("'Gemini (Google)' remove caracteres especiais", () => {
        expect(normalizeToolName('Gemini (Google)')).toBe('gemini google');
    });
});

// ── T2: recordShieldObservation — persiste com campos derivados ───────────────

describe('T2: recordShieldObservation persiste tool_name_normalized e user_identifier_hash', () => {
    it('INSERT no banco com campos normalizados e hash de usuário', async () => {
        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [ORG_ID]
            );
            const obs = await recordShieldObservation(client, {
                orgId:          ORG_ID,
                sourceType:     'manual',
                toolName:       TEST_TOOL,
                userIdentifier: 'user@example.com',
                departmentHint: 'engineering',
                observedAt:     new Date(),
                rawData:        { context: 'shield-test-t2' },
            });

            expect(obs.id).toBeTruthy();

            // Verificar que o banco armazenou os campos derivados corretamente
            const row = await client.query(
                'SELECT tool_name_normalized, user_identifier_hash FROM shield_observations_raw WHERE id = $1',
                [obs.id]
            );
            expect(row.rows).toHaveLength(1);
            expect(row.rows[0].tool_name_normalized).toBe(normalizeToolName(TEST_TOOL));
            expect(row.rows[0].user_identifier_hash).toBe(hashUserIdentifier('user@example.com'));
            // e-mail cru NÃO deve estar armazenado em nenhum campo
            const rawRow = await client.query(
                'SELECT raw_data FROM shield_observations_raw WHERE id = $1',
                [obs.id]
            );
            expect(JSON.stringify(rawRow.rows[0].raw_data)).not.toContain('user@example.com');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T3: processShieldObservations — cria/atualiza shield_tools ───────────────

describe('T3: processShieldObservations cria entrada em shield_tools', () => {
    it('após processamento, shield_tools contém a ferramenta detectada', async () => {
        // Inserir mais observações para garantir volume
        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [ORG_ID]
            );
            // Inserir 5 observações adicionais
            for (let i = 0; i < 5; i++) {
                await recordShieldObservation(client, {
                    orgId: ORG_ID, sourceType: 'manual', toolName: TEST_TOOL,
                    observedAt: new Date(Date.now() - i * 60000),
                });
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        const result = await processShieldObservations(pgPool, ORG_ID);
        expect(result.processedCount).toBeGreaterThan(0);

        // Verificar que a ferramenta foi criada no dicionário
        const toolRow = await pgPool.query(
            `SELECT id, tool_name_normalized FROM shield_tools
             WHERE org_id = $1 AND tool_name_normalized = $2`,
            [ORG_ID, normalizeToolName(TEST_TOOL)]
        );
        expect(toolRow.rows).toHaveLength(1);
        expect(toolRow.rows[0].tool_name_normalized).toBe(normalizeToolName(TEST_TOOL));
    });
});

// ── T4: processShieldObservations — rollup diário único ──────────────────────

describe('T4: processShieldObservations cria rollup diário único por (org, tool, period_start)', () => {
    it('rollup existe para a ferramenta de teste na data atual', async () => {
        const today = new Date().toISOString().slice(0, 10);

        const rollupRow = await pgPool.query(
            `SELECT id, observation_count, period_start
             FROM shield_rollups
             WHERE org_id = $1
               AND tool_name_normalized = $2
               AND period_start::date = $3::date`,
            [ORG_ID, normalizeToolName(TEST_TOOL), today]
        );
        expect(rollupRow.rows).toHaveLength(1);
        expect(rollupRow.rows[0].observation_count).toBeGreaterThan(0);
    });

    it('segundo processamento não duplica o rollup (ON CONFLICT UPDATE)', async () => {
        // Inserir mais observações e reprocessar
        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [ORG_ID]
            );
            for (let i = 0; i < 3; i++) {
                await recordShieldObservation(client, {
                    orgId: ORG_ID, sourceType: 'manual', toolName: TEST_TOOL,
                    observedAt: new Date(),
                });
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        await processShieldObservations(pgPool, ORG_ID);
        const today = new Date().toISOString().slice(0, 10);

        const rollupRow = await pgPool.query(
            `SELECT COUNT(*) AS cnt
             FROM shield_rollups
             WHERE org_id = $1
               AND tool_name_normalized = $2
               AND period_start::date = $3::date`,
            [ORG_ID, normalizeToolName(TEST_TOOL), today]
        );
        expect(parseInt(rollupRow.rows[0].cnt, 10)).toBe(1); // apenas 1 rollup por dia
    });
});

// ── T5: generateShieldFindings — cria finding open para ferramenta unknown ───

describe('T5: generateShieldFindings cria finding com risk_score, risk_dimensions, confidence', () => {
    it('finding aberto com score de risco calculado pelas 5 dimensões', async () => {
        const result = await generateShieldFindings(pgPool, ORG_ID);
        expect(typeof result.generated).toBe('number');
        expect(typeof result.updated).toBe('number');

        const findingRow = await pgPool.query(
            `SELECT id, status, severity, observation_count, risk_score, risk_dimensions, confidence
             FROM shield_findings
             WHERE org_id = $1 AND tool_name_normalized = $2
             ORDER BY created_at DESC LIMIT 1`,
            [ORG_ID, normalizeToolName(TEST_TOOL)]
        );
        expect(findingRow.rows).toHaveLength(1);
        const f = findingRow.rows[0];
        expect(f.status).toBe('open');
        expect(f.observation_count).toBeGreaterThan(0);
        // risk_score deve estar preenchido (0-100)
        expect(f.risk_score).toBeGreaterThanOrEqual(0);
        expect(f.risk_score).toBeLessThanOrEqual(100);
        // risk_dimensions deve ser objeto com as 5 dimensões
        expect(f.risk_dimensions).toBeTruthy();
        const dims = typeof f.risk_dimensions === 'string'
            ? JSON.parse(f.risk_dimensions) : f.risk_dimensions;
        expect(dims).toHaveProperty('baseRisk');
        expect(dims).toHaveProperty('exposure');
        expect(dims).toHaveProperty('businessContext');
        expect(dims).toHaveProperty('persistence');
        expect(dims).toHaveProperty('confidence');
    });
});

// ── T6: acknowledgeShieldFinding — atualiza status + gera action log ─────────

describe('T6: acknowledgeShieldFinding atualiza status e gera action log', () => {
    it('status muda de open para acknowledged + action log inserido', async () => {
        // Buscar finding aberto para o TEST_TOOL
        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [ORG_ID]
            );
            const findingRow = await client.query(
                `SELECT id FROM shield_findings
                 WHERE org_id = $1 AND tool_name_normalized = $2 AND status = 'open'
                 LIMIT 1`,
                [ORG_ID, normalizeToolName(TEST_TOOL)]
            );
            if (findingRow.rows.length === 0) return; // já processado

            const findingId = findingRow.rows[0].id as string;
            await acknowledgeShieldFinding(client, findingId, ACTOR_ID);

            // Status atualizado
            const updated = await client.query(
                'SELECT status, acknowledged_at, acknowledged_by FROM shield_findings WHERE id = $1',
                [findingId]
            );
            expect(updated.rows[0].status).toBe('acknowledged');
            expect(updated.rows[0].acknowledged_at).not.toBeNull();
            expect(updated.rows[0].acknowledged_by).toBe(ACTOR_ID);

            // Action log inserido
            const action = await client.query(
                `SELECT action_type, actor_user_id FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'acknowledge' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
            expect(action.rows[0].actor_user_id).toBe(ACTOR_ID);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T7: promoteShieldFindingToCatalog — cria assistant draft e marca promoted ─

describe('T7: promoteShieldFindingToCatalog cria assistant draft + finding promoted', () => {
    let promotedFindingId: string;
    let createdAssistantId: string;

    it('cria finding open dedicado e promove para o catálogo', async () => {
        // Criar finding manualmente para este teste ter controle do ID
        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [ORG_ID]
            );
            const newFinding = await client.query(
                `INSERT INTO shield_findings
                 (org_id, tool_name, tool_name_normalized, severity, rationale,
                  first_seen_at, last_seen_at, observation_count)
                 VALUES ($1, $2, $3, 'medium', 'Finding para teste T7 de promoção', NOW(), NOW(), 10)
                 RETURNING id`,
                [ORG_ID, TEST_TOOL + '_promote', normalizeToolName(TEST_TOOL + '_promote')]
            );
            promotedFindingId = newFinding.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        const result = await promoteShieldFindingToCatalog(
            pgPool, promotedFindingId, ACTOR_ID,
            { assistantName: '[Shield Test] Promote T7' }
        );

        expect(result.findingId).toBe(promotedFindingId);
        expect(result.assistantId).toBeTruthy();
        createdAssistantId = result.assistantId;

        // Verificar finding promovido
        const findingAfter = await pgPool.query(
            'SELECT status FROM shield_findings WHERE id = $1',
            [promotedFindingId]
        );
        expect(findingAfter.rows[0].status).toBe('promoted');

        // Verificar assistant draft criado
        const assistant = await pgPool.query(
            'SELECT id, name, lifecycle_state, status FROM assistants WHERE id = $1',
            [createdAssistantId]
        );
        expect(assistant.rows).toHaveLength(1);
        expect(assistant.rows[0].lifecycle_state).toBe('draft');
        expect(assistant.rows[0].status).toBe('draft');
    });
});

// ── T8: promoteShieldFindingToCatalog — gera evidence_records/links ───────────

describe('T8: promoteShieldFindingToCatalog gera evidence + link', () => {
    it('evidence_record SHIELD_FINDING_PROMOTED criado com integridade', async () => {
        // Criar outro finding para este teste
        const client = await pgPool.connect();
        let findingId: string;
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [ORG_ID]
            );
            const res = await client.query(
                `INSERT INTO shield_findings
                 (org_id, tool_name, tool_name_normalized, severity, rationale,
                  first_seen_at, last_seen_at, observation_count)
                 VALUES ($1, $2, $3, 'high', 'Finding para teste T8 de evidence', NOW(), NOW(), 15)
                 RETURNING id`,
                [ORG_ID, TEST_TOOL + '_evidence', normalizeToolName(TEST_TOOL + '_evidence')]
            );
            findingId = res.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        const result = await promoteShieldFindingToCatalog(pgPool, findingId, ACTOR_ID);

        // evidence_record deve existir
        expect(result.evidenceId).toBeTruthy();

        if (result.evidenceId) {
            const evRow = await pgPool.query(
                'SELECT event_type, integrity_hash, resource_type FROM evidence_records WHERE id = $1',
                [result.evidenceId]
            );
            expect(evRow.rows).toHaveLength(1);
            expect(evRow.rows[0].event_type).toBe('SHIELD_FINDING_PROMOTED');
            expect(evRow.rows[0].integrity_hash).toHaveLength(64);
            expect(evRow.rows[0].resource_type).toBe('assistant');
        }
    });
});

// ── T9: RLS — org A vê finding; org B não vê ─────────────────────────────────

describe('T9: RLS isola findings por org (govai_app role)', () => {
    it('org A vê o finding; org errada recebe 0 rows', async () => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE govai_app');
            await client.query(
                "SELECT set_config('app.current_org_id', $1, true)",
                [ORG_ID]
            );

            // Inserir finding para org A
            const { rows } = await client.query(
                `INSERT INTO shield_findings
                 (org_id, tool_name, tool_name_normalized, severity, rationale, observation_count)
                 VALUES ($1, 'rls-test-tool', 'rls-test-tool', 'medium', 'RLS test T9', 5)
                 RETURNING id`,
                [ORG_ID]
            );
            const findingId = rows[0].id;

            // Org A vê
            const visible = await client.query(
                'SELECT id FROM shield_findings WHERE id = $1',
                [findingId]
            );
            expect(visible.rows).toHaveLength(1);

            // Org errada não vê
            await client.query(
                "SELECT set_config('app.current_org_id', $1, true)",
                [WRONG_ORG_ID]
            );
            const invisible = await client.query(
                'SELECT id FROM shield_findings WHERE id = $1',
                [findingId]
            );
            expect(invisible.rows).toHaveLength(0);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

// ── T10: Endpoint real — GET /v1/admin/shield/findings responde 200 ───────────

describe('T10: GET /v1/admin/shield/findings responde 200 com auth válida', () => {
    it('endpoint retorna 200 com estrutura { findings, total }', async () => {
        const res = await app.inject({
            method: 'GET',
            url:    `/v1/admin/shield/findings?orgId=${ORG_ID}`,
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.findings)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(body.total).toBe(body.findings.length);
    });
});

// ── T11: acceptRisk — transição + action log + campos accepted_risk ───────────

describe('T11: acceptRisk transiciona finding para accepted_risk + gera action log', () => {
    it('status muda para accepted_risk, campos preenchidos, action log inserido', async () => {
        // Criar finding open dedicado para este teste
        const client = await pgPool.connect();
        let findingId: string;
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)",
                [ORG_ID]
            );
            const res = await client.query(
                `INSERT INTO shield_findings
                 (org_id, tool_name, tool_name_normalized, severity, rationale,
                  first_seen_at, last_seen_at, observation_count)
                 VALUES ($1, $2, $3, 'medium', 'Finding para T11 acceptRisk', NOW(), NOW(), 3)
                 RETURNING id`,
                [ORG_ID, 'workflow-test-accept-' + Date.now(), 'workflow-test-accept-risk']
            );
            findingId = res.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        await acceptRisk(pgPool, findingId, ACTOR_ID, 'Risco aceito para teste T11');

        const client2 = await pgPool.connect();
        try {
            await client2.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );

            const finding = await client2.query(
                `SELECT status, accepted_risk, accepted_risk_note, accepted_risk_at, accepted_risk_by
                 FROM shield_findings WHERE id = $1`,
                [findingId]
            );
            expect(finding.rows[0].status).toBe('accepted_risk');
            expect(finding.rows[0].accepted_risk).toBe(true);
            expect(finding.rows[0].accepted_risk_note).toBe('Risco aceito para teste T11');
            expect(finding.rows[0].accepted_risk_at).not.toBeNull();
            expect(finding.rows[0].accepted_risk_by).toBe(ACTOR_ID);

            const action = await client2.query(
                `SELECT action_type, actor_user_id, note FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'accept_risk' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
            expect(action.rows[0].actor_user_id).toBe(ACTOR_ID);
            expect(action.rows[0].note).toBe('Risco aceito para teste T11');
        } finally {
            await client2.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client2.release();
        }
    });
});

// ── T12: resolveFinding — transição + action log ──────────────────────────────

describe('T12: resolveFinding transiciona finding para resolved + gera action log', () => {
    it('status muda para resolved e action log inserido', async () => {
        const client = await pgPool.connect();
        let findingId: string;
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const res = await client.query(
                `INSERT INTO shield_findings
                 (org_id, tool_name, tool_name_normalized, severity, rationale,
                  first_seen_at, last_seen_at, observation_count)
                 VALUES ($1, $2, $3, 'low', 'Finding para T12 resolve', NOW(), NOW(), 2)
                 RETURNING id`,
                [ORG_ID, 'workflow-test-resolve-' + Date.now(), 'workflow-test-resolve']
            );
            findingId = res.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        await resolveFinding(pgPool, findingId, ACTOR_ID, 'Resolvido em T12');

        const client2 = await pgPool.connect();
        try {
            await client2.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );

            const finding = await client2.query(
                'SELECT status FROM shield_findings WHERE id = $1',
                [findingId]
            );
            expect(finding.rows[0].status).toBe('resolved');

            const action = await client2.query(
                `SELECT action_type, actor_user_id FROM shield_finding_actions
                 WHERE finding_id = $1 AND action_type = 'resolve' LIMIT 1`,
                [findingId]
            );
            expect(action.rows).toHaveLength(1);
            expect(action.rows[0].actor_user_id).toBe(ACTOR_ID);
        } finally {
            await client2.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client2.release();
        }
    });
});

// ── T13: generateExecutivePosture — persiste shield_posture_snapshots ─────────

describe('T13: generateExecutivePosture persiste snapshot em shield_posture_snapshots', () => {
    it('snapshot criado com summary_score e campos estruturados', async () => {
        const snapshot = await generateExecutivePosture(pgPool, ORG_ID, ACTOR_ID);

        expect(snapshot).toBeTruthy();
        expect(typeof snapshot.summaryScore).toBe('number');
        expect(snapshot.summaryScore).toBeGreaterThanOrEqual(0);
        expect(snapshot.summaryScore).toBeLessThanOrEqual(100);
        expect(typeof snapshot.openFindings).toBe('number');
        expect(Array.isArray(snapshot.topTools)).toBe(true);
        expect(Array.isArray(snapshot.recommendations)).toBe(true);

        // Verificar persistência no banco
        const client = await pgPool.connect();
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const row = await client.query(
                `SELECT id, summary_score, open_findings, recommendations
                 FROM shield_posture_snapshots
                 WHERE org_id = $1
                 ORDER BY generated_at DESC LIMIT 1`,
                [ORG_ID]
            );
            expect(row.rows).toHaveLength(1);
            expect(row.rows[0].summary_score).toBe(snapshot.summaryScore);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T20: POST /v1/admin/shield/findings/:id/accept-risk responde 200 ──────────

describe('T20: POST /v1/admin/shield/findings/:id/accept-risk responde 200', () => {
    it('endpoint aceita risco em finding aberto', async () => {
        // Criar finding open via DB
        const client = await pgPool.connect();
        let findingId: string;
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const res = await client.query(
                `INSERT INTO shield_findings
                 (org_id, tool_name, tool_name_normalized, severity, rationale,
                  first_seen_at, last_seen_at, observation_count)
                 VALUES ($1, $2, $3, 'low', 'Finding para T20 accept-risk route', NOW(), NOW(), 1)
                 RETURNING id`,
                [ORG_ID, 'workflow-test-ar-route-' + Date.now(), 'workflow-test-ar-route']
            );
            findingId = res.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        const res = await app.inject({
            method: 'POST',
            url:    `/v1/admin/shield/findings/${findingId}/accept-risk`,
            payload: { note: 'Aceito via T20' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.findingId).toBe(findingId);
    });
});

// ── T21: POST /v1/admin/shield/findings/:id/resolve responde 200 ──────────────

describe('T21: POST /v1/admin/shield/findings/:id/resolve responde 200', () => {
    it('endpoint resolve finding aberto', async () => {
        const client = await pgPool.connect();
        let findingId: string;
        try {
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]
            );
            const res = await client.query(
                `INSERT INTO shield_findings
                 (org_id, tool_name, tool_name_normalized, severity, rationale,
                  first_seen_at, last_seen_at, observation_count)
                 VALUES ($1, $2, $3, 'low', 'Finding para T21 resolve route', NOW(), NOW(), 1)
                 RETURNING id`,
                [ORG_ID, 'workflow-test-resolve-route-' + Date.now(), 'workflow-test-resolve-route']
            );
            findingId = res.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        const res = await app.inject({
            method: 'POST',
            url:    `/v1/admin/shield/findings/${findingId}/resolve`,
            payload: { note: 'Resolvido via T21' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.findingId).toBe(findingId);
    });
});

// ── T22: GET /v1/admin/shield/posture responde 200 ───────────────────────────

describe('T22: GET /v1/admin/shield/posture responde 200', () => {
    it('endpoint retorna snapshot mais recente ou 404 sem snapshot', async () => {
        const res = await app.inject({
            method: 'GET',
            url:    `/v1/admin/shield/posture?orgId=${ORG_ID}`,
        });

        // 200 se snapshot existe (T13 já gerou), 404 se não há snapshot ainda
        expect([200, 404]).toContain(res.statusCode);
        if (res.statusCode === 200) {
            const body = JSON.parse(res.body);
            expect(typeof body.summary_score).toBe('number');
        }
    });
});

// ── T23: POST /v1/admin/shield/posture/generate responde 200 ─────────────────

describe('T23: POST /v1/admin/shield/posture/generate responde 200', () => {
    it('endpoint gera e persiste novo snapshot de postura', async () => {
        const res = await app.inject({
            method: 'POST',
            url:    '/v1/admin/shield/posture/generate',
            payload: { orgId: ORG_ID },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(typeof body.summaryScore).toBe('number');
        expect(body.summaryScore).toBeGreaterThanOrEqual(0);
        expect(body.summaryScore).toBeLessThanOrEqual(100);
    });
});
