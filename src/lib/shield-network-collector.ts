/**
 * Shield Network Collector — Proxy / SWG / Network Signal Ingestion
 *
 * Aceita lotes de sinais de rede (proxy, SWG, CASB) e os converte em
 * observações canônicas do Shield.
 *
 * OPERAÇÃO: admin-triggered (sem worker BullMQ nesta sprint).
 *   Coleta periódica assíncrona fica para Sprint G.
 *
 * REGRAS:
 *   - user_identifier_hash = SHA-256(user identifier) — nunca plain
 *   - sourceType = 'network' (valor válido no CHECK constraint)
 *   - set_config(..., false) — session-level, limpeza no finally
 *   - last_sync_at / last_error atualizados no collector
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';
import { normalizeToolName, recordShieldObservation } from './shield';

// ── Hashing utilitário ────────────────────────────────────────────────────────

function sha256(value: string): string {
    return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface NetworkCollectorConfig {
    orgId: string;
    collectorName: string;
    sourceKind: 'proxy' | 'swg' | 'network';
}

export interface NetworkCollectorRecord {
    id: string;
    orgId: string;
    collectorName: string;
    sourceKind: string;
    status: string;
    lastSyncAt: Date | null;
}

/** Evento de rede bruto vindo de proxy/SWG — formato flexível por design. */
export interface RawNetworkEvent {
    toolName: string;
    userIdentifier?: string;   // email ou username — será hashed
    departmentHint?: string;
    observedAt: string | Date;
    metadata?: Record<string, unknown>;
}

/** Resultado de ingestão de lote. */
export interface IngestResult {
    ingested: number;
    errors: string[];
}

// ── storeNetworkCollector ─────────────────────────────────────────────────────

/**
 * Persiste (ou retorna existente por nome+org) um Network Collector.
 */
export async function storeNetworkCollector(
    pgPool: Pool,
    config: NetworkCollectorConfig
): Promise<NetworkCollectorRecord> {
    const result = await pgPool.query(
        `INSERT INTO shield_network_collectors
         (org_id, collector_name, source_kind)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id, org_id, collector_name, source_kind, status, last_sync_at`,
        [config.orgId, config.collectorName, config.sourceKind]
    );

    if (result.rows.length > 0) {
        const r = result.rows[0];
        return {
            id:            r.id as string,
            orgId:         r.org_id as string,
            collectorName: r.collector_name as string,
            sourceKind:    r.source_kind as string,
            status:        r.status as string,
            lastSyncAt:    r.last_sync_at as Date | null,
        };
    }

    // Linha já existia — SELECT para retornar
    const existing = await pgPool.query(
        `SELECT id, org_id, collector_name, source_kind, status, last_sync_at
         FROM shield_network_collectors
         WHERE org_id = $1 AND collector_name = $2`,
        [config.orgId, config.collectorName]
    );
    const r = existing.rows[0];
    return {
        id:            r.id as string,
        orgId:         r.org_id as string,
        collectorName: r.collector_name as string,
        sourceKind:    r.source_kind as string,
        status:        r.status as string,
        lastSyncAt:    r.last_sync_at as Date | null,
    };
}

// ── normalizeNetworkSignal ────────────────────────────────────────────────────

/**
 * Converte um RawNetworkEvent para o payload canônico do Shield.
 * Normaliza o nome da ferramenta e hasha o user identifier.
 */
export function normalizeNetworkSignal(event: RawNetworkEvent): {
    toolName: string;
    toolNameNormalized: string;
    userIdentifierHash: string | null;
    departmentHint: string | null;
    observedAt: Date;
    sourceMetadata: Record<string, unknown>;
} {
    const toolNameNormalized = normalizeToolName(event.toolName);
    const userIdentifierHash = event.userIdentifier
        ? sha256(event.userIdentifier)
        : null;

    return {
        toolName: event.toolName,
        toolNameNormalized,
        userIdentifierHash,
        departmentHint:   event.departmentHint ?? null,
        observedAt:       new Date(event.observedAt),
        sourceMetadata:   event.metadata ?? {},
    };
}

// ── ingestNetworkBatch ────────────────────────────────────────────────────────

/**
 * Ingere lote de sinais de rede como observações canônicas do Shield.
 *
 * - Persiste em shield_network_events_raw (log de rede)
 * - Persiste em shield_observations_raw (pipeline principal do Shield)
 * - Atualiza last_sync_at / last_error no collector
 * - user_identifier_hash = SHA-256(userIdentifier) — nunca plain
 * - sourceType = 'network'
 */
export async function ingestNetworkBatch(
    pgPool: Pool,
    orgId: string,
    collectorId: string,
    events: RawNetworkEvent[]
): Promise<IngestResult> {
    const errors: string[] = [];
    let ingested = 0;

    const client = await pgPool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        for (const event of events) {
            try {
                if (!event.toolName?.trim()) {
                    errors.push(`Evento ignorado: toolName ausente`);
                    continue;
                }

                const normalized = normalizeNetworkSignal(event);

                // Persistir em shield_network_events_raw (log de rede)
                await client.query(
                    `INSERT INTO shield_network_events_raw
                     (org_id, collector_id, tool_name, tool_name_normalized,
                      user_identifier_hash, department_hint, observed_at,
                      source_metadata, raw_data)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [
                        orgId,
                        collectorId,
                        normalized.toolName,
                        normalized.toolNameNormalized,
                        normalized.userIdentifierHash,
                        normalized.departmentHint,
                        normalized.observedAt,
                        JSON.stringify(normalized.sourceMetadata),
                        JSON.stringify({ original: event.toolName }),
                    ]
                );

                // Persistir em shield_observations_raw (pipeline Shield)
                await recordShieldObservation(
                    client as any,
                    {
                        orgId,
                        toolName:          normalized.toolName,
                        toolNameNormalized: normalized.toolNameNormalized,
                        userIdentifierHash: normalized.userIdentifierHash ?? undefined,
                        sourceType:        'network',
                        observedAt:        normalized.observedAt,
                        rawData: {
                            departmentHint: normalized.departmentHint,
                            collectorId,
                            ...normalized.sourceMetadata,
                        },
                    }
                );

                ingested++;
            } catch (err: any) {
                errors.push(`Evento '${event.toolName}': ${err.message}`);
            }
        }

        // Atualizar last_sync_at e limpar last_error no collector
        const updateFields = errors.length > 0
            ? `last_sync_at = now(), last_error = $2, updated_at = now()`
            : `last_sync_at = now(), last_error = NULL, updated_at = now()`;

        await client.query(
            `UPDATE shield_network_collectors
             SET ${updateFields}
             WHERE id = $1`,
            errors.length > 0
                ? [collectorId, errors.slice(0, 3).join('; ')]
                : [collectorId]
        );

        return { ingested, errors };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
