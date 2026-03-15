/**
 * GovAI Platform — API Key Rotation / TTL Enforcement Job
 *
 * P-11: Enforces TTL on api_keys. Runs daily at 2:00 AM via BullMQ.
 *
 * Lógica por ciclo:
 *   a. DESATIVAR chaves vencidas (expires_at < NOW) com revoke_reason='expired_ttl'
 *   b. ALERTAR chaves próximas do vencimento (< 14 dias) via logger.warn
 *   c. APLICAR TTL padrão (90 dias) em chaves sem expires_at
 *
 * Segurança: api_keys tem RLS. Usamos SET ROLE platform_admin para
 * operações cross-tenant (mesmo padrão do expiration.worker).
 */

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { pgPool } from '../lib/db';
import { captureError } from '../lib/monitoring';

const CRON = '0 2 * * *'; // Todo dia às 2h
const TTL_DAYS = 90;
const WARN_DAYS = 14;

// ── Redis connection ─────────────────────────────────────────────────────────

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

connection.on('error', (err) => {
    console.error('[ApiKeyRotation] Redis connection error:', err);
});

export const apiKeyRotationQueue = new Queue('api-key-rotation', { connection: connection as any });

// ── Core logic (exported for testing) ──────────────────────────────────────────

interface RevokedRow {
    id: string;
    org_id: string;
    name: string;
    prefix: string;
}

interface ExpiringSoonRow {
    id: string;
    org_id: string;
    name: string;
    prefix: string;
    expires_at: Date;
}

interface TtlAppliedRow {
    id: string;
    prefix: string;
}

export async function runApiKeyRotationCycle(
    pool: Pool,
    logger: { warn: (msg: string, data?: Record<string, unknown>) => void } = console
): Promise<void> {
    const client = await pool.connect();

    try {
        await client.query('SET ROLE platform_admin');

        // a. DESATIVAR chaves vencidas
        const revokedRes = await client.query<RevokedRow>(
            `UPDATE api_keys
             SET    is_active     = false,
                    revoke_reason = 'expired_ttl',
                    revoked_at    = NOW()
             WHERE  expires_at < NOW()
               AND  is_active = true
               AND  revoke_reason IS NULL
             RETURNING id, org_id, name, prefix`
        );

        for (const row of revokedRes.rows) {
            logger.warn('[ApiKeyRotation] Key expired and deactivated', {
                id: row.id,
                org_id: row.org_id,
                name: row.name,
                prefix: row.prefix,
            });
        }

        // b. ALERTAR chaves próximas do vencimento (< 14 dias)
        const expiringRes = await client.query<ExpiringSoonRow>(
            `SELECT id, org_id, name, prefix, expires_at
             FROM api_keys
             WHERE expires_at BETWEEN NOW() AND NOW() + ($1 || ' days')::INTERVAL
               AND is_active = true
             ORDER BY expires_at ASC`,
            [WARN_DAYS]
        );

        for (const row of expiringRes.rows) {
            logger.warn('[ApiKeyRotation] Key expiring soon', {
                id: row.id,
                org_id: row.org_id,
                name: row.name,
                prefix: row.prefix,
                expires_at: row.expires_at,
            });
        }

        // c. APLICAR TTL padrão (90 dias) em chaves sem expiração
        const ttlRes = await client.query<TtlAppliedRow>(
            `UPDATE api_keys
             SET expires_at = created_at + ($1 || ' days')::INTERVAL
             WHERE expires_at IS NULL
               AND is_active = true
             RETURNING id, prefix`,
            [TTL_DAYS]
        );

        if (ttlRes.rows.length > 0) {
            logger.warn('[ApiKeyRotation] Applied default TTL (90 days) to keys without expiration', {
                count: ttlRes.rows.length,
                ids: ttlRes.rows.map(r => r.id),
            });
        }
    } finally {
        let resetErr: Error | undefined;
        try {
            await client.query('RESET ROLE');
        } catch (e) {
            resetErr = e instanceof Error ? e : new Error(String(e));
        }
        client.release(resetErr);
    }
}

// ── Worker bootstrap ─────────────────────────────────────────────────────────

export function initApiKeyRotationJob(): Worker {
    const worker = new Worker('api-key-rotation', async () => {
        await runApiKeyRotationCycle(pgPool);
    }, { connection: connection as any });

    worker.on('failed', (job: any, err: any) => {
        console.error('[ApiKeyRotation] Job failed:', job?.id, err);
        captureError(err instanceof Error ? err : new Error(String(err)), {
            job: 'api-key-rotation',
            jobId: job?.id,
        });
    });

    apiKeyRotationQueue.add('rotate-keys', {}, {
        repeat: { pattern: CRON },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
    }).catch(err => {
        console.error('[ApiKeyRotation] Failed to schedule repeatable job:', err);
    });

    console.log('[ApiKeyRotation] Started — cron', CRON);
    return worker;
}
