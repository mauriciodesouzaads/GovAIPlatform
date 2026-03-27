/**
 * Shield Ingestion Service
 *
 * Funções de normalização, hash e ingestão de observações brutas.
 */

import { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';

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
