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
    promoteShieldFindingToCatalog,
    listShieldFindings,
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
    // Limpar dados de teste inseridos (shield_findings/rollups/observations/tools)
    // não são imutáveis — pode deletar
    const client = await pgPool.connect();
    try {
        const normalized = normalizeToolName(TEST_TOOL);
        await client.query(
            `DELETE FROM shield_findings WHERE org_id = $1 AND tool_name_normalized = $2`,
            [ORG_ID, normalized]
        );
        await client.query(
            `DELETE FROM shield_rollups WHERE org_id = $1 AND tool_name_normalized = $2`,
            [ORG_ID, normalized]
        );
        await client.query(
            `DELETE FROM shield_observations_raw WHERE org_id = $1 AND tool_name_normalized = $2`,
            [ORG_ID, normalized]
        );
        await client.query(
            `DELETE FROM shield_tools WHERE org_id = $1 AND tool_name_normalized = $2`,
            [ORG_ID, normalized]
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

describe('T5: generateShieldFindings cria finding open para ferramenta desconhecida', () => {
    it('finding aberto criado com severidade calculada', async () => {
        const result = await generateShieldFindings(pgPool, ORG_ID);
        expect(typeof result.generated).toBe('number');
        expect(typeof result.updated).toBe('number');

        const findingRow = await pgPool.query(
            `SELECT id, status, severity, observation_count
             FROM shield_findings
             WHERE org_id = $1 AND tool_name_normalized = $2
             ORDER BY created_at DESC LIMIT 1`,
            [ORG_ID, normalizeToolName(TEST_TOOL)]
        );
        expect(findingRow.rows).toHaveLength(1);
        expect(findingRow.rows[0].status).toBe('open');
        expect(['medium', 'high']).toContain(findingRow.rows[0].severity);
        expect(findingRow.rows[0].observation_count).toBeGreaterThan(0);
    });
});

// ── T6: acknowledgeShieldFinding — atualiza status + timestamps ───────────────

describe('T6: acknowledgeShieldFinding atualiza status, acknowledged_at e acknowledged_by', () => {
    it('status muda de open para acknowledged', async () => {
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
            if (findingRow.rows.length === 0) {
                // Se o finding já foi promovido em T7, criar um novo
                return;
            }
            const findingId = findingRow.rows[0].id as string;

            await acknowledgeShieldFinding(client, findingId, ACTOR_ID);

            const updated = await client.query(
                'SELECT status, acknowledged_at, acknowledged_by FROM shield_findings WHERE id = $1',
                [findingId]
            );
            expect(updated.rows[0].status).toBe('acknowledged');
            expect(updated.rows[0].acknowledged_at).not.toBeNull();
            expect(updated.rows[0].acknowledged_by).toBe(ACTOR_ID);
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
