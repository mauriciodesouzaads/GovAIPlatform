/**
 * Shield Core — Detection Foundation
 *
 * Funções do núcleo de detecção de uso shadow AI:
 *   - normalização de nomes de ferramentas
 *   - hash de identidade de usuário (nunca e-mail cru)
 *   - ingestão de observações brutas
 *   - processamento (upsert shield_tools + rollup diário)
 *   - geração de findings
 *   - acknowledge / promote-to-catalog
 *
 * O que esta sprint NÃO entrega:
 *   - collectors corporativos reais (M365, Google, DNS, browser extension)
 *   - workers de processamento assíncrono
 *   - regras de severidade complexas
 *   Ver ADR-003 para roadmap.
 *
 * Regra de set_config:
 *   Usar false (session-level). Limpar no finally.
 *   Nunca usar true (transaction-local) — ver F1 spec regra #3.
 */

import { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';
import { recordEvidence, linkEvidence } from './evidence';

type DbClient = Pool | PoolClient;

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export interface ShieldObservationPayload {
    orgId: string;
    sourceType: 'manual' | 'oauth' | 'network' | 'browser' | 'api';
    toolName: string;
    userIdentifier?: string | null;  // nunca armazenar cru — será hashed
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
    const toolNameNormalized = normalizeToolName(payload.toolName);
    const userIdentifierHash = payload.userIdentifier
        ? hashUserIdentifier(payload.userIdentifier)
        : null;

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

        // Rollups dos últimos 30 dias
        const rollups = await client.query(
            `SELECT r.tool_name_normalized,
                    SUM(r.observation_count)::int AS total_obs,
                    MAX(r.unique_users)::int       AS max_users,
                    MAX(r.last_seen_at)            AS last_seen,
                    MIN(r.period_start)            AS first_seen,
                    t.approval_status
             FROM shield_rollups r
             LEFT JOIN shield_tools t
               ON t.org_id = r.org_id AND t.tool_name_normalized = r.tool_name_normalized
             WHERE r.org_id = $1
               AND r.period_start > NOW() - INTERVAL '30 days'
             GROUP BY r.tool_name_normalized, t.approval_status`,
            [orgId]
        );

        for (const row of rollups.rows) {
            const normalized   = row.tool_name_normalized as string;
            const totalObs     = row.total_obs as number;
            const maxUsers     = row.max_users as number;
            const lastSeen     = row.last_seen;
            const firstSeen    = row.first_seen;
            const approvalStatus = (row.approval_status as string | null) ?? 'unknown';

            // Ferramentas aprovadas não geram findings abertos
            if (approvalStatus === 'approved') continue;

            // Calcular severidade
            let severity = 'medium';
            if (totalObs >= 20) severity = 'high';
            else if (totalObs < 5) continue; // volume insuficiente

            const rationale = `Ferramenta '${normalized}' detectada com ${totalObs} observações (${maxUsers} usuários únicos) nos últimos 30 dias. Status de aprovação: ${approvalStatus}.`;

            // Buscar ferramenta real no dicionário
            const toolRow = await client.query(
                `SELECT id, tool_name FROM shield_tools
                 WHERE org_id = $1 AND tool_name_normalized = $2 LIMIT 1`,
                [orgId, normalized]
            );
            const toolId   = toolRow.rows[0]?.id ?? null;
            const toolName = toolRow.rows[0]?.tool_name ?? normalized;

            // Verificar finding existente (open ou acknowledged)
            const existing = await client.query(
                `SELECT id FROM shield_findings
                 WHERE org_id = $1
                   AND tool_name_normalized = $2
                   AND status IN ('open', 'acknowledged')
                 LIMIT 1`,
                [orgId, normalized]
            );

            if (existing.rows.length > 0) {
                // Atualizar finding existente
                await client.query(
                    `UPDATE shield_findings
                     SET observation_count = $1,
                         unique_users      = $2,
                         last_seen_at      = $3,
                         severity          = $4,
                         rationale         = $5,
                         tool_id           = COALESCE(tool_id, $6)
                     WHERE id = $7`,
                    [totalObs, maxUsers, lastSeen, severity, rationale, toolId, existing.rows[0].id]
                );
                updated++;
            } else {
                // Criar novo finding
                await client.query(
                    `INSERT INTO shield_findings
                     (org_id, tool_name, tool_name_normalized, tool_id, severity,
                      rationale, first_seen_at, last_seen_at, observation_count, unique_users)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [orgId, toolName, normalized, toolId, severity,
                     rationale, firstSeen, lastSeen, totalObs, maxUsers]
                );
                generated++;
            }
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

// ── acknowledgeShieldFinding ──────────────────────────────────────────────────

export async function acknowledgeShieldFinding(
    db: DbClient,
    findingId: string,
    actorUserId: string
): Promise<void> {
    await (db as Pool).query(
        `UPDATE shield_findings
         SET status          = 'acknowledged',
             acknowledged_at = NOW(),
             acknowledged_by = $2
         WHERE id = $1 AND status = 'open'`,
        [findingId, actorUserId]
    );
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
