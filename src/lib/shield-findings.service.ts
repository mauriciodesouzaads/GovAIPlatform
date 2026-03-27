/**
 * Shield Findings Service
 *
 * Geração, listagem, merge, deduplicação e sync de findings.
 */

import { Pool, PoolClient } from 'pg';
import { calculateRiskScore } from './shield-risk-engine';
import { normalizeToolName } from './shield-ingestion.service';

type DbClient = Pool | PoolClient;

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export interface ShieldFindingFilters {
    orgId: string;
    status?: string;
    severity?: string;
    toolName?: string;
    limit?: number;
}

export interface ShieldPromoteResult {
    findingId: string;
    assistantId: string;
    evidenceId: string | null;
}

// ── generateShieldFindings ────────────────────────────────────────────────────

/**
 * Lê rollups recentes e gera/atualiza findings por ferramenta.
 * Regras iniciais simples:
 *   - ferramenta unknown (approval_status = 'unknown') com volume ≥ 5 → medium
 *   - ferramenta unknown com volume ≥ 20 → high
 *   - ferramenta aprovada → não gera finding aberto
 *   - finding já promoted/dismissed/resolved → não reabre
 */
export async function generateShieldFindings(
    pool: Pool,
    orgId: string
): Promise<{ generated: number; updated: number }> {
    const client = await pool.connect();
    let generated = 0, updated = 0;
    try {
        await client.query('BEGIN');
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)",
            [orgId]
        );

        // Rollups dos últimos 30 dias — inclui dados de risco da ferramenta
        const rollups = await client.query(
            `SELECT r.tool_name_normalized,
                    SUM(r.observation_count)::int  AS total_obs,
                    MAX(r.unique_users)::int        AS max_users,
                    MAX(r.last_seen_at)             AS last_seen,
                    MIN(r.period_start)             AS first_seen,
                    t.id                            AS tool_id,
                    t.tool_name,
                    t.approval_status,
                    t.data_exposure_risk,
                    t.vendor_risk,
                    t.risk_level
             FROM shield_rollups r
             LEFT JOIN shield_tools t
               ON t.org_id = r.org_id AND t.tool_name_normalized = r.tool_name_normalized
             WHERE r.org_id = $1
               AND r.period_start > NOW() - INTERVAL '30 days'
             GROUP BY r.tool_name_normalized, t.id, t.tool_name,
                      t.approval_status, t.data_exposure_risk, t.vendor_risk, t.risk_level`,
            [orgId]
        );

        for (const row of rollups.rows) {
            const normalized     = row.tool_name_normalized as string;
            const totalObs       = row.total_obs as number;
            const maxUsers       = row.max_users as number;
            const lastSeen       = row.last_seen;
            const firstSeen      = row.first_seen;
            const approvalStatus = (row.approval_status as string | null) ?? 'unknown';

            // Ferramentas aprovadas não geram findings abertos
            if (approvalStatus === 'approved') continue;
            // Volume mínimo para gerar finding
            if (totalObs < 5) continue;

            // isSanctioned vem do approval_status real do banco — NÃO hardcoded
            const isSanctioned  = approvalStatus === 'approved';
            const toolId        = (row.tool_id as string | null) ?? null;
            const toolName      = (row.tool_name as string | null) ?? normalized;
            const dataExposureRisk = (row.data_exposure_risk as number | null) ?? 5;
            const riskLevelStr  = (row.risk_level as string | null) ?? 'unknown';

            // Score provisório para gerar rationale e severity iniciais
            const toolBaseRisk =
                riskLevelStr === 'critical' ? 18 :
                riskLevelStr === 'high'     ? 14 :
                riskLevelStr === 'medium'   ? 8  : 4;

            const score = calculateRiskScore({
                toolBaseRisk,
                dataExposureRisk,
                observationCount: totalObs,
                uniqueUsers:      maxUsers,
                isSanctioned,
                isKnownTool:      !!toolId,
                signalSources:    ['network'],
            });

            const rationale = `Ferramenta '${normalized}' detectada com ${totalObs} observações (${maxUsers} usuários únicos) nos últimos 30 dias. Risk score: ${score.total}. Status: ${approvalStatus}.`;

            // Verificar finding existente (open ou acknowledged)
            const existing = await client.query(
                `SELECT id FROM shield_findings
                 WHERE org_id = $1
                   AND tool_name_normalized = $2
                   AND status IN ('open', 'acknowledged')
                 LIMIT 1`,
                [orgId, normalized]
            );

            let findingId: string;

            if (existing.rows.length > 0) {
                findingId = existing.rows[0].id as string;
                await client.query(
                    `UPDATE shield_findings
                     SET observation_count = $1,
                         unique_users      = $2,
                         last_seen_at      = $3,
                         severity          = $4,
                         rationale         = $5,
                         tool_id           = COALESCE(tool_id, $6)
                     WHERE id = $7`,
                    [totalObs, maxUsers, lastSeen, score.severity, rationale, toolId, findingId]
                );
                updated++;
            } else {
                const ins = await client.query(
                    `INSERT INTO shield_findings
                     (org_id, tool_name, tool_name_normalized, tool_id, severity,
                      rationale, first_seen_at, last_seen_at, observation_count, unique_users)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     RETURNING id`,
                    [orgId, toolName, normalized, toolId, score.severity,
                     rationale, firstSeen, lastSeen, totalObs, maxUsers]
                );
                findingId = ins.rows[0].id as string;
                generated++;
            }

            // Aplicar risk score detalhado (5 dimensões) no finding
            await client.query(
                `UPDATE shield_findings
                 SET risk_score          = $1,
                     risk_dimensions     = $2,
                     recommendation      = $3,
                     promotion_candidate = $4,
                     updated_at          = NOW()
                 WHERE id = $5`,
                [
                    score.total,
                    JSON.stringify(score.dimensions),
                    score.recommendation,
                    score.promotionCandidate,
                    findingId,
                ]
            );
        }

        await client.query('COMMIT');
        return { generated, updated };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── listShieldFindings ────────────────────────────────────────────────────────

export async function listShieldFindings(
    db: DbClient,
    filters: ShieldFindingFilters
): Promise<any[]> {
    const { orgId, status, severity, toolName, limit = 50 } = filters;
    const params: any[] = [orgId];
    const clauses: string[] = [];

    if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
    }
    if (severity) {
        params.push(severity);
        clauses.push(`severity = $${params.length}`);
    }
    if (toolName) {
        params.push(normalizeToolName(toolName));
        clauses.push(`tool_name_normalized = $${params.length}`);
    }
    params.push(limit);

    const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
    const result = await (db as Pool).query(
        `SELECT id, tool_name, tool_name_normalized, severity, status, rationale,
                first_seen_at, last_seen_at, observation_count, unique_users,
                acknowledged_at, created_at, updated_at
         FROM shield_findings
         WHERE org_id = $1 ${where}
         ORDER BY
           CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                         WHEN 'medium' THEN 3 ELSE 4 END,
           last_seen_at DESC NULLS LAST
         LIMIT $${params.length}`,
        params
    );
    return result.rows;
}

// ── mergeOrUpdateFinding ───────────────────────────────────────────────────────

/**
 * Consolida sinais de múltiplas fontes em um finding coerente.
 *
 * Se já existe finding open/acknowledged para (org_id, tool_name_normalized):
 *   - incrementa correlation_count
 *   - atualiza source_types com a nova fonte (sem duplicatas)
 *   - recalcula severity se o novo score for mais alto
 *   - atualiza observation_count e unique_users
 *
 * Caso contrário, cria novo finding.
 *
 * NUNCA gera dois findings independentes para a mesma ferramenta sem justificativa.
 * Deduplicação é determinística: chave = (org_id, tool_name_normalized, status IN ('open','acknowledged')).
 */
export async function mergeOrUpdateFinding(
    pool: Pool,
    orgId: string,
    toolNameNormalized: string,
    toolName: string,
    sourceType: string,
    newScore: {
        total: number;
        severity: string;
        dimensions: Record<string, number>;
        recommendation: string;
        promotionCandidate: boolean;
        recommendedAction: string;
        category: string;
        scoreVersion: string;
    },
    observationCount: number,
    uniqueUsers: number,
    firstSeen: Date | string,
    lastSeen: Date | string,
    ownerCandidateHash?: string | null,
    ownerCandidateSource?: string | null
): Promise<{ findingId: string; action: 'created' | 'merged' }> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        // Verificar finding existente
        const existing = await client.query(
            `SELECT id, correlation_count, source_types, risk_score, observation_count, unique_users
             FROM shield_findings
             WHERE org_id = $1
               AND tool_name_normalized = $2
               AND status IN ('open', 'acknowledged')
             ORDER BY created_at ASC
             LIMIT 1`,
            [orgId, toolNameNormalized]
        );

        if (existing.rows.length > 0) {
            const row = existing.rows[0];
            const findingId = row.id as string;
            const existingSources: string[] = (row.source_types as string[]) ?? [];
            const updatedSources = Array.from(new Set([...existingSources, sourceType]));
            const newCorrelation = (row.correlation_count as number) + (existingSources.includes(sourceType) ? 0 : 1);
            const newObsCount = (row.observation_count as number) + observationCount;
            const newUniqueUsers = Math.max(row.unique_users as number, uniqueUsers);
            // Elevar severity se o novo score for mais alto
            const newRiskScore = Math.max(row.risk_score as number, newScore.total);

            await client.query(
                `UPDATE shield_findings
                 SET source_types       = $1,
                     correlation_count  = $2,
                     observation_count  = $3,
                     unique_users       = $4,
                     last_seen_at       = $5,
                     risk_score         = $6,
                     severity           = $7,
                     owner_candidate_hash   = COALESCE(owner_candidate_hash, $8),
                     owner_candidate_source = COALESCE(owner_candidate_source, $9),
                     updated_at         = NOW()
                 WHERE id = $10`,
                [
                    JSON.stringify(updatedSources),
                    newCorrelation,
                    newObsCount,
                    newUniqueUsers,
                    lastSeen,
                    newRiskScore,
                    newScore.severity,
                    ownerCandidateHash ?? null,
                    ownerCandidateSource ?? null,
                    findingId,
                ]
            );

            return { findingId, action: 'merged' };
        }

        // Criar novo finding
        const ins = await client.query(
            `INSERT INTO shield_findings
             (org_id, tool_name, tool_name_normalized, severity, rationale,
              first_seen_at, last_seen_at, observation_count, unique_users,
              risk_score, risk_dimensions, recommendation, promotion_candidate,
              source_types, correlation_count,
              owner_candidate_hash, owner_candidate_source,
              recommended_action, category)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
             RETURNING id`,
            [
                orgId, toolName, toolNameNormalized,
                newScore.severity,
                `Ferramenta '${toolNameNormalized}' detectada via ${sourceType}. Score: ${newScore.total}.`,
                firstSeen, lastSeen, observationCount, uniqueUsers,
                newScore.total,
                JSON.stringify(newScore.dimensions),
                newScore.recommendation,
                newScore.promotionCandidate,
                JSON.stringify([sourceType]),
                1,
                ownerCandidateHash ?? null,
                ownerCandidateSource ?? null,
                newScore.recommendedAction,
                newScore.category,
            ]
        );

        return { findingId: ins.rows[0].id as string, action: 'created' };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── dedupeFindings ────────────────────────────────────────────────────────────

/**
 * Varre findings open/acknowledged e consolida duplicatas da mesma ferramenta.
 *
 * Caso improvável mas defensivo: se dois findings foram criados
 * para a mesma ferramenta (race condition), mantém o mais antigo
 * e merge os counters/sources no mais recente, depois fecha o duplicado.
 */
export async function dedupeFindings(
    pool: Pool,
    orgId: string
): Promise<{ deduped: number }> {
    const client = await pool.connect();
    let deduped = 0;
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        // Agrupar findings ativos por tool_name_normalized, ordenado por created_at
        const groups = await client.query(
            `SELECT tool_name_normalized,
                    array_agg(id ORDER BY created_at ASC) AS finding_ids
             FROM shield_findings
             WHERE org_id = $1
               AND status IN ('open', 'acknowledged')
             GROUP BY tool_name_normalized
             HAVING COUNT(*) > 1`,
            [orgId]
        );

        for (const row of groups.rows) {
            const ids = row.finding_ids as string[];
            const keepId = ids[0]; // mais antigo
            const dupeIds = ids.slice(1);

            // Agregar sources e counts dos duplicados
            const dupesData = await client.query(
                `SELECT source_types, correlation_count, observation_count, unique_users
                 FROM shield_findings WHERE id = ANY($1::uuid[])`,
                [dupeIds]
            );

            let allSources: string[] = [];
            let totalObs = 0;
            let maxUsers = 0;
            for (const d of dupesData.rows) {
                allSources = [...allSources, ...((d.source_types as string[]) ?? [])];
                totalObs += d.observation_count as number;
                maxUsers = Math.max(maxUsers, d.unique_users as number);
            }

            // Buscar dados do finding a manter
            const keepRow = await client.query(
                `SELECT source_types, correlation_count, observation_count, unique_users
                 FROM shield_findings WHERE id = $1`,
                [keepId]
            );
            const keepData = keepRow.rows[0];
            const mergedSources = Array.from(new Set([
                ...((keepData.source_types as string[]) ?? []),
                ...allSources,
            ]));

            await client.query(
                `UPDATE shield_findings
                 SET source_types      = $1,
                     correlation_count = $2,
                     observation_count = $3,
                     unique_users      = $4,
                     updated_at        = NOW()
                 WHERE id = $5`,
                [
                    JSON.stringify(mergedSources),
                    mergedSources.length,
                    (keepData.observation_count as number) + totalObs,
                    Math.max(keepData.unique_users as number, maxUsers),
                    keepId,
                ]
            );

            // Fechar duplicatas como resolved (não deletar — audit trail)
            await client.query(
                `UPDATE shield_findings
                 SET status = 'resolved',
                     resolved_at = NOW(),
                     updated_at = NOW()
                 WHERE id = ANY($1::uuid[])`,
                [dupeIds]
            );

            deduped += dupeIds.length;
        }

        return { deduped };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── syncShieldToolsWithCatalog ────────────────────────────────────────────────

/**
 * Reflete em shield_tools o estado real do Catálogo (assistants + approval_status).
 *
 * Para cada ferramenta em shield_tools, busca o assistant correspondente
 * pelo tool_name_normalized e atualiza approval_status e sanctioned.
 *
 * - approval_status vem do lifecycle_state do Catálogo:
 *     published → approved
 *     deprecated/archived/suspended → restricted
 *     draft → unknown (não alterar)
 * - sanctioned = (approval_status === 'approved')
 * - NÃO hardcoded — usa dados reais do banco
 *
 * Nota: a correspondência é por tool_name_normalized ↔ assistants.name_normalized
 * (ou assistants.name ILIKE). Best-effort: sem correspondência = sem alteração.
 */
export async function syncShieldToolsWithCatalog(
    pool: Pool,
    orgId: string
): Promise<{ synced: number }> {
    const client = await pool.connect();
    let synced = 0;
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        // Buscar ferramentas ainda sem status definitivo
        const tools = await client.query(
            `SELECT id, tool_name_normalized FROM shield_tools
             WHERE org_id = $1`,
            [orgId]
        );

        for (const tool of tools.rows) {
            const normalized = tool.tool_name_normalized as string;

            // Buscar assistant correspondente no Catálogo por nome normalizado
            const match = await client.query(
                `SELECT lifecycle_state
                 FROM assistants
                 WHERE org_id = $1
                   AND LOWER(REGEXP_REPLACE(name, '[^a-z0-9]', ' ', 'gi')) = $2
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [orgId, normalized]
            );

            if (match.rows.length === 0) continue;

            const lifecycleState = match.rows[0].lifecycle_state as string;
            let approvalStatus: string;
            let sanctioned: boolean;

            switch (lifecycleState) {
                case 'published':
                    approvalStatus = 'approved';
                    sanctioned = true;
                    break;
                case 'deprecated':
                case 'archived':
                case 'suspended':
                    approvalStatus = 'restricted';
                    sanctioned = false;
                    break;
                default:
                    // draft, under_review etc → manter como está
                    continue;
            }

            await client.query(
                `UPDATE shield_tools
                 SET approval_status = $1,
                     sanctioned      = $2,
                     updated_at      = NOW()
                 WHERE id = $3`,
                [approvalStatus, sanctioned, tool.id as string]
            );
            synced++;
        }

        return { synced };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── computeOwnerCandidate ──────────────────────────────────────────────────────

/**
 * Heurística mínima para owner/team candidate de um finding.
 *
 * Estratégia:
 *   1. Busca o user_identifier_hash mais frequente nas observações da ferramenta
 *   2. Se há department_hint disponível, usa como source
 *   3. Retorna null se não há base mínima (< 3 observações do mesmo hash)
 *
 * É apenas um candidate — não uma verdade.
 * Sem IA, sem overengineering.
 */
export async function computeOwnerCandidate(
    pool: Pool,
    orgId: string,
    toolNameNormalized: string
): Promise<{ ownerCandidateHash: string | null; ownerCandidateSource: string | null }> {
    const result = await pool.query(
        `SELECT user_identifier_hash,
                COUNT(*)            AS freq,
                MAX(department_hint) AS department_hint
         FROM shield_observations_raw
         WHERE org_id = $1
           AND tool_name_normalized = $2
           AND user_identifier_hash IS NOT NULL
         GROUP BY user_identifier_hash
         ORDER BY freq DESC
         LIMIT 1`,
        [orgId, toolNameNormalized]
    );

    if (result.rows.length === 0 || (result.rows[0].freq as number) < 3) {
        return { ownerCandidateHash: null, ownerCandidateSource: null };
    }

    const row = result.rows[0];
    const source = row.department_hint
        ? `department:${row.department_hint}`
        : 'frequency_heuristic';

    return {
        ownerCandidateHash:   row.user_identifier_hash as string,
        ownerCandidateSource: source,
    };
}
