/**
 * Shield Core — Detection & Risk Intelligence Plane
 *
 * Funções do núcleo de detecção de uso shadow AI:
 *   - normalização de nomes de ferramentas
 *   - hash de identidade de usuário (nunca e-mail cru)
 *   - ingestão de observações brutas
 *   - processamento (upsert shield_tools + rollup diário)
 *   - geração de findings com risk score 5 dimensões
 *   - workflow completo de findings:
 *       acknowledge / accept_risk / dismiss / resolve / reopen / promote
 *   - postura executiva persistida em shield_posture_snapshots
 *   - deduplicação e correlação multissinal (Sprint S1-R)
 *   - sync de approval_status com Catálogo (Sprint S1-R)
 *   - owner/team candidate por heurística (Sprint S1-R)
 *
 * Coleta disponível: manual + Microsoft Graph OAuth + Google Workspace + Network/SWG.
 * Workers/BullMQ: não implementado — coleta admin-triggered nesta sprint.
 * SSE/CASB/browser extension: ver ADR-004 para roadmap.
 *
 * Regra de set_config:
 *   Usar false (session-level). Limpar no finally.
 *   Nunca usar true (transaction-local).
 */

import { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';
import { recordEvidence, linkEvidence } from './evidence';
import { calculateRiskScore, updateFindingRiskScore } from './shield-risk-engine';

type DbClient = Pool | PoolClient;

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export interface ShieldObservationPayload {
    orgId: string;
    sourceType: 'manual' | 'oauth' | 'network' | 'browser' | 'api';
    toolName: string;
    toolNameNormalized?: string;     // opcional: se não fornecido, derivado de normalizeToolName
    userIdentifier?: string | null;  // nunca armazenar cru — será hashed
    userIdentifierHash?: string | null; // pré-hashed — usado pelo network collector
    departmentHint?: string | null;
    observedAt: Date | string;
    rawData?: Record<string, unknown>;
}

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

// ── normalizeToolName ──────────────────────────────────────────────────────────

/**
 * Produz uma chave estável a partir do nome bruto de uma ferramenta.
 * ' ChatGPT  ' → 'chatgpt'
 * 'Microsoft Copilot' → 'microsoft copilot'
 */
export function normalizeToolName(input: string): string {
    return input
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')         // colapsar múltiplos espaços
        .replace(/[^\w\s\-\.]/g, '')  // remover ruído (parênteses, slashes, etc.)
        .trim();
}

// ── hashUserIdentifier ────────────────────────────────────────────────────────

/**
 * Deriva um identificador anônimo a partir de qualquer string (e-mail, username, etc.).
 * Regra da sprint: nunca armazenar e-mail cru como campo principal.
 */
export function hashUserIdentifier(input: string): string {
    return createHash('sha256').update(input.trim().toLowerCase()).digest('hex');
}

// ── recordShieldObservation ───────────────────────────────────────────────────

/**
 * Insere uma observação bruta na tabela shield_observations_raw.
 * Normaliza tool_name e hash do identificador de usuário.
 * Requer que app.current_org_id esteja configurado na conexão (RLS).
 */
export async function recordShieldObservation(
    db: DbClient,
    payload: ShieldObservationPayload
): Promise<{ id: string }> {
    const toolNameNormalized = payload.toolNameNormalized ?? normalizeToolName(payload.toolName);
    // userIdentifierHash: aceita pré-hashed (do network collector) ou deriva de userIdentifier
    const userIdentifierHash = payload.userIdentifierHash
        ?? (payload.userIdentifier ? hashUserIdentifier(payload.userIdentifier) : null);

    const result = await (db as Pool).query(
        `INSERT INTO shield_observations_raw
         (org_id, source_type, tool_name, tool_name_normalized,
          user_identifier_hash, department_hint, observed_at, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
            payload.orgId,
            payload.sourceType,
            payload.toolName,
            toolNameNormalized,
            userIdentifierHash,
            payload.departmentHint ?? null,
            payload.observedAt,
            JSON.stringify(payload.rawData ?? {}),
        ]
    );
    return { id: result.rows[0].id as string };
}

// ── processShieldObservations ─────────────────────────────────────────────────

/**
 * Processa até `limit` observações pendentes para uma org:
 *   1. Agrupa por tool_name_normalized
 *   2. Upsert em shield_tools
 *   3. Upsert de rollup diário em shield_rollups
 *   4. Marca as observações como processed = true
 *
 * Roda dentro de uma transação.
 * Requer que app.current_org_id esteja configurado na conexão do caller.
 */
export async function processShieldObservations(
    pool: Pool,
    orgId: string,
    limit = 500
): Promise<{ processedCount: number }> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)",
            [orgId]
        );

        // Selecionar observações não processadas
        const obsResult = await client.query(
            `SELECT id, tool_name, tool_name_normalized, user_identifier_hash, observed_at
             FROM shield_observations_raw
             WHERE org_id = $1 AND processed = FALSE
             ORDER BY observed_at ASC
             LIMIT $2`,
            [orgId, limit]
        );

        if (obsResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { processedCount: 0 };
        }

        const ids = obsResult.rows.map((r: any) => r.id);

        // Agrupar por tool_name_normalized para upsert em shield_tools
        const toolGroups = new Map<string, { toolName: string; count: number }>();
        for (const row of obsResult.rows) {
            const key = row.tool_name_normalized as string;
            if (!toolGroups.has(key)) {
                toolGroups.set(key, { toolName: row.tool_name as string, count: 0 });
            }
            toolGroups.get(key)!.count++;
        }

        // Upsert shield_tools
        for (const [normalized, { toolName }] of toolGroups) {
            await client.query(
                `INSERT INTO shield_tools (org_id, tool_name, tool_name_normalized)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (org_id, tool_name_normalized) DO NOTHING`,
                [orgId, toolName, normalized]
            );
        }

        // Rollup diário — agrupar por (tool_name_normalized, dia)
        type RollupKey = string; // `${normalized}::${day}`
        const rollupMap = new Map<RollupKey, {
            normalized: string;
            periodStart: string;
            periodEnd: string;
            count: number;
            users: Set<string>;
            lastSeen: string;
        }>();

        for (const row of obsResult.rows) {
            const normalized = row.tool_name_normalized as string;
            const day = (row.observed_at as Date).toISOString().slice(0, 10); // YYYY-MM-DD
            const key = `${normalized}::${day}`;

            if (!rollupMap.has(key)) {
                rollupMap.set(key, {
                    normalized,
                    periodStart: `${day}T00:00:00Z`,
                    periodEnd:   `${day}T23:59:59.999Z`,
                    count:       0,
                    users:       new Set(),
                    lastSeen:    row.observed_at as string,
                });
            }
            const entry = rollupMap.get(key)!;
            entry.count++;
            if (row.user_identifier_hash) entry.users.add(row.user_identifier_hash);
            if (new Date(row.observed_at) > new Date(entry.lastSeen)) {
                entry.lastSeen = row.observed_at;
            }
        }

        for (const entry of rollupMap.values()) {
            // Buscar tool_id para referência FK (pode ser NULL se não existir ainda)
            const toolRow = await client.query(
                `SELECT id FROM shield_tools
                 WHERE org_id = $1 AND tool_name_normalized = $2
                 LIMIT 1`,
                [orgId, entry.normalized]
            );
            const toolId = toolRow.rows[0]?.id ?? null;

            await client.query(
                `INSERT INTO shield_rollups
                 (org_id, tool_name_normalized, tool_id, period_start, period_end,
                  observation_count, unique_users, last_seen_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (org_id, tool_name_normalized, period_start) DO UPDATE
                   SET observation_count = shield_rollups.observation_count + EXCLUDED.observation_count,
                       unique_users      = GREATEST(shield_rollups.unique_users, EXCLUDED.unique_users),
                       last_seen_at      = GREATEST(shield_rollups.last_seen_at, EXCLUDED.last_seen_at),
                       tool_id           = COALESCE(shield_rollups.tool_id, EXCLUDED.tool_id)`,
                [
                    orgId,
                    entry.normalized,
                    toolId,
                    entry.periodStart,
                    entry.periodEnd,
                    entry.count,
                    entry.users.size,
                    entry.lastSeen,
                ]
            );
        }

        // Marcar observações como processadas
        await client.query(
            `UPDATE shield_observations_raw
             SET processed = TRUE
             WHERE id = ANY($1::uuid[])`,
            [ids]
        );

        await client.query('COMMIT');
        return { processedCount: ids.length };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
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

// ── insertFindingAction (helper privado) ──────────────────────────────────────

async function insertFindingAction(
    db: DbClient,
    orgId: string,
    findingId: string,
    actionType: string,
    actorUserId: string | null,
    note?: string | null
): Promise<void> {
    await (db as Pool).query(
        `INSERT INTO shield_finding_actions
         (org_id, finding_id, action_type, actor_user_id, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, findingId, actionType, actorUserId, note ?? null]
    );
}

// ── acknowledgeShieldFinding ──────────────────────────────────────────────────

export async function acknowledgeShieldFinding(
    db: DbClient,
    findingId: string,
    actorUserId: string
): Promise<void> {
    // Buscar org_id do finding para o action log
    const row = await (db as Pool).query(
        `UPDATE shield_findings
         SET status          = 'acknowledged',
             acknowledged_at = NOW(),
             acknowledged_by = $2
         WHERE id = $1 AND status = 'open'
         RETURNING org_id`,
        [findingId, actorUserId]
    );
    if (row.rows.length > 0) {
        const orgId = row.rows[0].org_id as string;
        await insertFindingAction(db, orgId, findingId, 'acknowledge', actorUserId);
    }
}

// ── promoteShieldFindingToCatalog ─────────────────────────────────────────────

/**
 * Promove um finding para o catálogo de capacidades:
 *   1. Cria um assistant draft mínimo na tabela assistants
 *   2. Marca o finding como promoted
 *   3. Gera evidence_record (categoria: publication)
 *   4. Linka o evidence ao finding via evidence_links
 *
 * Toda a operação ocorre em uma transação.
 * Requer app.current_org_id configurado (session-level, false).
 */
export async function promoteShieldFindingToCatalog(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    options: { assistantName?: string; category?: string } = {}
): Promise<ShieldPromoteResult> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Carregar finding
        const findingResult = await client.query(
            `SELECT id, org_id, tool_name, tool_name_normalized, severity
             FROM shield_findings WHERE id = $1`,
            [findingId]
        );
        if (findingResult.rows.length === 0) {
            throw new Error(`Finding ${findingId} não encontrado.`);
        }
        const finding = findingResult.rows[0];
        const orgId = finding.org_id as string;

        // Configurar contexto org (session-level, limpo no finally)
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)",
            [orgId]
        );

        // Criar assistant draft mínimo no catálogo
        const assistantName = options.assistantName
            ?? `[Shield Draft] ${finding.tool_name}`;
        const assistantResult = await client.query(
            `INSERT INTO assistants
             (org_id, name, status, lifecycle_state, description, risk_level, owner_id)
             VALUES ($1, $2, 'draft', 'draft', $3, $4, $5)
             RETURNING id`,
            [
                orgId,
                assistantName,
                `Capability draft promovida automaticamente pelo Shield Core. Ferramenta detectada: ${finding.tool_name_normalized}.`,
                finding.severity === 'high' || finding.severity === 'critical' ? 'high' : 'medium',
                actorUserId,
            ]
        );
        const assistantId = assistantResult.rows[0].id as string;

        // Atualizar finding → promoted
        await client.query(
            `UPDATE shield_findings
             SET status = 'promoted'
             WHERE id = $1`,
            [findingId]
        );

        // Log da ação de promoção
        await insertFindingAction(client, orgId, findingId, 'promote', actorUserId);

        await client.query('COMMIT');

        // Gerar evidence FORA da transação principal (não-fatal, usa pool direto)
        // set_config session-level já está ativo na conexão do pool
        const ev = await recordEvidence(pool, {
            orgId,
            category:     'publication',
            eventType:    'SHIELD_FINDING_PROMOTED',
            actorId:      actorUserId,
            resourceType: 'assistant',
            resourceId:   assistantId,
            metadata: {
                findingId,
                toolName: finding.tool_name,
                toolNameNormalized: finding.tool_name_normalized,
                severity: finding.severity,
            },
        });

        // Linkar evidence ao finding via resource_id
        if (ev) {
            await linkEvidence(pool, ev.id, findingId, 'promoted_from_finding');
        }

        return {
            findingId,
            assistantId,
            evidenceId: ev?.id ?? null,
        };
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

// ── acceptRisk ────────────────────────────────────────────────────────────────

/**
 * Marca um finding como risco aceito.
 * Transição válida: open | acknowledged → accepted_risk.
 * Gera action log.
 */
export async function acceptRisk(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status            = 'accepted_risk',
                 accepted_risk     = true,
                 accepted_risk_note = $2,
                 accepted_risk_at  = NOW(),
                 accepted_risk_by  = $3
             WHERE id = $1
               AND status IN ('open','acknowledged')
             RETURNING org_id`,
            [findingId, note ?? null, actorUserId]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'accept_risk', actorUserId, note);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── dismissFinding ────────────────────────────────────────────────────────────

/**
 * Descarta um finding (falso positivo, fora de escopo, etc.).
 * Transição válida: open | acknowledged → dismissed.
 * Gera action log.
 */
export async function dismissFinding(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status       = 'dismissed',
                 dismissed_at = NOW(),
                 dismissed_by = $2
             WHERE id = $1
               AND status IN ('open','acknowledged')
             RETURNING org_id`,
            [findingId, actorUserId]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'dismiss', actorUserId, note);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── resolveFinding ────────────────────────────────────────────────────────────

/**
 * Marca um finding como resolvido (ferramenta desativada, controlada, etc.).
 * Transição válida: qualquer status ativo → resolved.
 * Gera action log.
 */
export async function resolveFinding(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status      = 'resolved',
                 resolved_at = NOW(),
                 resolved_by = $2
             WHERE id = $1
               AND status NOT IN ('promoted','resolved')
             RETURNING org_id`,
            [findingId, actorUserId]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'resolve', actorUserId, note);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── reopenFinding ─────────────────────────────────────────────────────────────

/**
 * Reabre um finding (dismissed ou resolved).
 * Transição válida: dismissed | resolved | accepted_risk → open.
 * Gera action log.
 */
export async function reopenFinding(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status           = 'open',
                 accepted_risk    = false,
                 accepted_risk_at = NULL,
                 accepted_risk_by = NULL,
                 dismissed_at     = NULL,
                 dismissed_by     = NULL,
                 resolved_at      = NULL,
                 resolved_by      = NULL
             WHERE id = $1
               AND status IN ('dismissed','resolved','accepted_risk')
             RETURNING org_id`,
            [findingId]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'reopen', actorUserId, note);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── generateExecutivePosture ──────────────────────────────────────────────────

/**
 * Gera e persiste um snapshot de postura executiva em shield_posture_snapshots.
 * Consolida: findings por severidade/status, top tools, promoted, accepted_risk.
 * Retorna estrutura pronta para API/relatório.
 *
 * Não requer app.current_org_id externo — configura e limpa internamente.
 */
export async function generateExecutivePosture(
    pool: Pool,
    orgId: string,
    generatedBy: string
): Promise<{
    snapshotId: string;
    summaryScore: number;
    openFindings: number;
    promotedFindings: number;
    acceptedRisk: number;
    topTools: Array<{ toolName: string; score: number; severity: string }>;
    recommendations: string[];
}> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        // Contagens de findings por status
        const counts = await client.query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'open')          AS open_count,
               COUNT(*) FILTER (WHERE status = 'acknowledged')  AS ack_count,
               COUNT(*) FILTER (WHERE status = 'promoted')      AS promoted_count,
               COUNT(*) FILTER (WHERE status = 'accepted_risk') AS accepted_count,
               COUNT(*) FILTER (WHERE severity = 'critical')    AS critical_count,
               COUNT(*) FILTER (WHERE severity = 'high')        AS high_count,
               COALESCE(AVG(risk_score), 0)::int                AS avg_score
             FROM shield_findings
             WHERE org_id = $1 AND status IN ('open','acknowledged','accepted_risk')`,
            [orgId]
        );

        const c = counts.rows[0];
        const openFindings     = parseInt(c.open_count ?? '0') + parseInt(c.ack_count ?? '0');
        const promotedFindings = parseInt(c.promoted_count ?? '0');
        const acceptedRisk     = parseInt(c.accepted_count ?? '0');
        const summaryScore     = c.avg_score ?? 0;
        const criticalCount    = parseInt(c.critical_count ?? '0');
        const highCount        = parseInt(c.high_count ?? '0');

        // Top tools por risk_score
        const topToolsResult = await client.query(
            `SELECT tool_name, COALESCE(risk_score, 0) AS risk_score, severity
             FROM shield_findings
             WHERE org_id = $1 AND status IN ('open','acknowledged')
             ORDER BY risk_score DESC NULLS LAST
             LIMIT 5`,
            [orgId]
        );
        const topTools = topToolsResult.rows.map(r => ({
            toolName: r.tool_name as string,
            score:    r.risk_score as number,
            severity: r.severity as string,
        }));

        // Recomendações dinâmicas
        const recommendations: string[] = [];
        if (criticalCount > 0)
            recommendations.push(`${criticalCount} ferramenta(s) de risco crítico requerem ação imediata.`);
        if (highCount > 0)
            recommendations.push(`Iniciar catalogação para ${highCount} ferramenta(s) de alto risco.`);
        if (promotedFindings > 0)
            recommendations.push(`${promotedFindings} ferramenta(s) promovida(s) ao catálogo aguardam revisão.`);
        if (recommendations.length === 0)
            recommendations.push('Nenhuma ação crítica pendente. Manter monitoramento.');

        // Persistir snapshot
        const snap = await client.query(
            `INSERT INTO shield_posture_snapshots
             (org_id, posture, summary_score, open_findings,
              promoted_findings, accepted_risk, top_tools, recommendations)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
                orgId,
                JSON.stringify({ criticalCount, highCount, summaryScore, generatedBy }),
                summaryScore,
                openFindings,
                promotedFindings,
                acceptedRisk,
                JSON.stringify(topTools),
                JSON.stringify(recommendations),
            ]
        );
        const snapshotId = snap.rows[0].id as string;

        return { snapshotId, summaryScore, openFindings, promotedFindings, acceptedRisk, topTools, recommendations };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
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
