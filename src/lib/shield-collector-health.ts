/**
 * Shield Collector Health — Sprint S3
 *
 * Funções de health tracking para collectors do Shield.
 * Aplica a: shield_oauth_collectors, shield_google_collectors,
 *   shield_network_collectors.
 *
 * Regras:
 *   - set_config(..., false) — session-level, limpar no finally
 *   - Sem e-mail plain; sem token plain
 *   - Erro nunca falha silenciosamente
 *   - health_status: healthy | degraded | error | unknown
 */

import { Pool } from 'pg';

export type CollectorKind = 'oauth' | 'google' | 'network';

export interface CollectorHealthRecord {
    id: string;
    kind: CollectorKind;
    collectorName: string;
    healthStatus: 'healthy' | 'degraded' | 'error' | 'unknown';
    successCount: number;
    failureCount: number;
    lastSuccessAt: Date | null;
    lastError: string | null;
    nextRunAt: Date | null;
}

// ── helpers internos ───────────────────────────────────────────────────────────

function tableForKind(kind: CollectorKind): string {
    switch (kind) {
        case 'oauth':    return 'shield_oauth_collectors';
        case 'google':   return 'shield_google_collectors';
        case 'network':  return 'shield_network_collectors';
    }
}

function nameColumnForKind(kind: CollectorKind): string {
    switch (kind) {
        case 'oauth':    return 'provider';
        case 'google':   return 'collector_name';
        case 'network':  return 'collector_name';
    }
}

function computeHealth(successCount: number, failureCount: number): 'healthy' | 'degraded' | 'error' {
    const total = successCount + failureCount;
    if (total === 0) return 'healthy';          // recém-criado, sem histórico de falha
    const rate = failureCount / total;
    if (rate === 0)    return 'healthy';
    if (rate < 0.5)    return 'degraded';
    return 'error';
}

// ── recordCollectorSuccess ────────────────────────────────────────────────────

/**
 * Registra execução bem-sucedida de um collector.
 * Incrementa success_count, atualiza last_success_at e health_status.
 * Limpa last_error se existia.
 */
export async function recordCollectorSuccess(
    pool: Pool,
    kind: CollectorKind,
    collectorId: string,
    orgId: string
): Promise<void> {
    const table = tableForKind(kind);
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );
        const current = await client.query(
            `SELECT success_count, failure_count FROM ${table}
             WHERE id = $1 AND org_id = $2`,
            [collectorId, orgId]
        );
        if (current.rows.length === 0) return;

        const s = (current.rows[0].success_count as number) + 1;
        const f = current.rows[0].failure_count as number;
        const health = computeHealth(s, f);

        await client.query(
            `UPDATE ${table}
             SET success_count   = $1,
                 last_success_at = NOW(),
                 health_status   = $2,
                 last_error      = NULL,
                 updated_at      = NOW()
             WHERE id = $3 AND org_id = $4`,
            [s, health, collectorId, orgId]
        );
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── recordCollectorFailure ────────────────────────────────────────────────────

/**
 * Registra falha de execução de um collector.
 * Incrementa failure_count, persiste last_error, atualiza health_status.
 * Erro nunca falha silenciosamente — a mensagem é truncada a 1000 chars.
 */
export async function recordCollectorFailure(
    pool: Pool,
    kind: CollectorKind,
    collectorId: string,
    orgId: string,
    errorMessage: string
): Promise<void> {
    const table = tableForKind(kind);
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );
        const current = await client.query(
            `SELECT success_count, failure_count FROM ${table}
             WHERE id = $1 AND org_id = $2`,
            [collectorId, orgId]
        );
        if (current.rows.length === 0) return;

        const s = current.rows[0].success_count as number;
        const f = (current.rows[0].failure_count as number) + 1;
        const health = computeHealth(s, f);
        const truncatedError = errorMessage.slice(0, 1000);

        await client.query(
            `UPDATE ${table}
             SET failure_count = $1,
                 last_error    = $2,
                 health_status = $3,
                 updated_at    = NOW()
             WHERE id = $4 AND org_id = $5`,
            [f, truncatedError, health, collectorId, orgId]
        );
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── getCollectorHealth ────────────────────────────────────────────────────────

/**
 * Retorna o health status de todos os collectors de uma org.
 * Consolida oauth + google + network em um único array.
 */
export async function getCollectorHealth(
    pool: Pool,
    orgId: string
): Promise<CollectorHealthRecord[]> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        const records: CollectorHealthRecord[] = [];

        // OAuth collectors
        const oauth = await client.query(
            `SELECT id, provider AS collector_name, health_status,
                    success_count, failure_count, last_success_at,
                    last_error, next_run_at
             FROM shield_oauth_collectors WHERE org_id = $1`,
            [orgId]
        );
        for (const r of oauth.rows) {
            records.push({
                id: r.id, kind: 'oauth',
                collectorName: r.collector_name,
                healthStatus:  r.health_status,
                successCount:  r.success_count,
                failureCount:  r.failure_count,
                lastSuccessAt: r.last_success_at,
                lastError:     r.last_error,
                nextRunAt:     r.next_run_at,
            });
        }

        // Google collectors
        const google = await client.query(
            `SELECT id, collector_name, health_status,
                    success_count, failure_count, last_success_at,
                    last_error, next_run_at
             FROM shield_google_collectors WHERE org_id = $1`,
            [orgId]
        );
        for (const r of google.rows) {
            records.push({
                id: r.id, kind: 'google',
                collectorName: r.collector_name,
                healthStatus:  r.health_status,
                successCount:  r.success_count,
                failureCount:  r.failure_count,
                lastSuccessAt: r.last_success_at,
                lastError:     r.last_error,
                nextRunAt:     r.next_run_at,
            });
        }

        // Network collectors
        const network = await client.query(
            `SELECT id, collector_name, health_status,
                    success_count, failure_count, last_success_at,
                    last_error, next_run_at
             FROM shield_network_collectors WHERE org_id = $1`,
            [orgId]
        );
        for (const r of network.rows) {
            records.push({
                id: r.id, kind: 'network',
                collectorName: r.collector_name,
                healthStatus:  r.health_status,
                successCount:  r.success_count,
                failureCount:  r.failure_count,
                lastSuccessAt: r.last_success_at,
                lastError:     r.last_error,
                nextRunAt:     r.next_run_at,
            });
        }

        return records;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── scheduleNextRun ───────────────────────────────────────────────────────────

/**
 * Persiste next_run_at para um collector (suporte a scheduling externo).
 * O scheduler real (BullMQ/cron) fica para Sprint G.
 * Esta função apenas persiste o timestamp planejado.
 */
export async function scheduleNextRun(
    pool: Pool,
    kind: CollectorKind,
    collectorId: string,
    orgId: string,
    nextRunAt: Date
): Promise<void> {
    const table = tableForKind(kind);
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );
        await client.query(
            `UPDATE ${table} SET next_run_at = $1, updated_at = NOW()
             WHERE id = $2 AND org_id = $3`,
            [nextRunAt, collectorId, orgId]
        );
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
