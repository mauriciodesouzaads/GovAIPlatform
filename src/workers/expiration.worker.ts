/**
 * GovAI Platform — Expiration Worker
 *
 * Expira pending_approvals vencidas (status='pending' AND expires_at <= NOW()).
 * Roda a cada 5 minutos via BullMQ repeatable job.
 *
 * P-02: SET ROLE platform_admin (BYPASSRLS) envolve o UPDATE cross-tenant.
 *   - SET ROLE executado imediatamente antes do UPDATE
 *   - RESET ROLE executado em bloco finally — sempre, inclusive em erro
 *   - Se RESET ROLE falhar, client.release(err) sinaliza conexão corrompida
 *     ao pool (evita reuso de conexão com role escalada)
 *   - Log estruturado registra contagem por org_id (sem expor conteúdo)
 */

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { notificationQueue } from './notification.worker';
import { pgPool } from '../lib/db';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExpiredRow {
    id:            string;
    org_id:        string;
    assistant_id:  string;
    policy_reason: string;
    trace_id:      string;
}

// ── Redis connection ───────────────────────────────────────────────────────────

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

connection.on('error', (err) => {
    console.error('[ExpirationWorker] Redis connection error:', err);
});

export const expirationQueue = new Queue('approval-expiration', { connection: connection as any });

// ── Core sweep logic (exported for testing) ───────────────────────────────────

/**
 * Executa um ciclo de expiração de aprovações vencidas.
 *
 * Modelo de segurança (P-02):
 *   1. SET ROLE platform_admin  — assume BYPASSRLS de forma explícita
 *   2. UPDATE pending_approvals — modifica registros de todos os tenants
 *   3. RESET ROLE               — revoga BYPASSRLS imediatamente (em finally)
 *
 * A janela de BYPASSRLS é restrita à duração de uma única query UPDATE.
 * client.release(resetErr) descarta a conexão do pool se RESET ROLE falhar,
 * impedindo que uma conexão com role escalada seja reutilizada.
 */
export async function runExpirationSweep(pool: Pool): Promise<void> {
    const client = await pool.connect();
    let expiredRows: ExpiredRow[] = [];

    try {
        // P-02: BYPASSRLS explícito — janela mínima (somente o UPDATE abaixo)
        await client.query('SET ROLE platform_admin');

        const result = await client.query<ExpiredRow>(
            `UPDATE pending_approvals
             SET    status      = 'expired',
                    reviewed_at = NOW(),
                    review_note = 'Expirado automaticamente (TTL 48h)'
             WHERE  status = 'pending'
               AND  expires_at <= NOW()
             RETURNING id, org_id, assistant_id, policy_reason, trace_id`
        );

        expiredRows = result.rows;

        // Log estruturado: quantidade por org (sem expor conteúdo das aprovações)
        if (expiredRows.length > 0) {
            const countByOrg = expiredRows.reduce<Record<string, number>>((acc, r) => {
                acc[r.org_id] = (acc[r.org_id] ?? 0) + 1;
                return acc;
            }, {});

            console.log('[ExpirationWorker] Sweep complete', JSON.stringify({
                total_expired:  expiredRows.length,
                orgs_affected:  Object.keys(countByOrg).length,
                by_org:         countByOrg,
            }));
        }

    } finally {
        // RESET ROLE sempre executado — govai_app volta a ter RLS ativo.
        // Se RESET ROLE falhar, sinaliza conexão corrompida ao pool via release(err),
        // impedindo reuso de uma conexão com platform_admin ainda ativo.
        let resetErr: Error | undefined;
        try {
            await client.query('RESET ROLE');
        } catch (e) {
            resetErr = e instanceof Error ? e : new Error(String(e));
        }
        client.release(resetErr);
    }

    // Notificações disparadas APÓS liberar a conexão do pool:
    // evita segurar a conexão de DB enquanto enfileira no Redis.
    for (const row of expiredRows) {
        try {
            await notificationQueue.add('send-notification', {
                event:       'APPROVAL_EXPIRED',
                orgId:       row.org_id,
                assistantId: row.assistant_id,
                approvalId:  row.id,
                reason:      row.policy_reason,
                traceId:     row.trace_id,
                timestamp:   new Date().toISOString(),
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
        } catch (notifyErr) {
            console.error(`[ExpirationWorker] Notification failed for approval ${row.id}:`, notifyErr);
        }
    }
}

// ── Worker bootstrap ──────────────────────────────────────────────────────────

export const initExpirationWorker = () => {
    const worker = new Worker('approval-expiration', async (_job) => {
        await runExpirationSweep(pgPool);
    }, { connection: connection as any });

    worker.on('failed', (job: any, err: any) => {
        console.error(`[ExpirationWorker] Job ${job?.id} failed:`, err);
    });

    expirationQueue.add('sweep-expired', {}, {
        repeat: { every: 5 * 60 * 1000 },
        removeOnComplete: { count: 10 },
        removeOnFail:     { count: 50 },
    }).catch(err => {
        console.error('[ExpirationWorker] Failed to schedule repeatable job:', err);
    });

    console.log('[ExpirationWorker] Started — sweeping expired approvals every 5 minutes');
    return worker;
};
