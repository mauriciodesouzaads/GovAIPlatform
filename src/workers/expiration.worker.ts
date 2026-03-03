import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import IORedis from 'ioredis';
import { dispatchNotification } from '../lib/notification-service';

/**
 * Expiration Worker — Periodically expires stale pending approvals.
 * 
 * Runs via BullMQ repeatable job every 5 minutes.
 * Marks any pending_approvals with expires_at < NOW() as 'expired'.
 * Dispatches notification for each expired approval.
 */

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

export const expirationQueue = new Queue('approval-expiration', { connection: connection as any });

export const initExpirationWorker = () => {
    const worker = new Worker('approval-expiration', async (_job) => {
        const client = await pgPool.connect();
        try {
            // Atomically expire all stale pending approvals
            const result = await client.query(
                `UPDATE pending_approvals 
                 SET status = 'expired', reviewed_at = NOW(), review_note = 'Expirado automaticamente (TTL 48h)'
                 WHERE status = 'pending' AND expires_at <= NOW()
                 RETURNING id, org_id, assistant_id, policy_reason, trace_id`
            );

            if (result.rows.length > 0) {
                console.log(`[ExpirationWorker] Expired ${result.rows.length} stale approval(s)`);

                // Notify for each expired approval
                for (const row of result.rows) {
                    try {
                        await dispatchNotification({
                            event: 'APPROVAL_EXPIRED',
                            orgId: row.org_id,
                            assistantId: row.assistant_id,
                            approvalId: row.id,
                            reason: row.policy_reason,
                            traceId: row.trace_id,
                            timestamp: new Date().toISOString(),
                        });
                    } catch (notifyErr) {
                        console.error(`[ExpirationWorker] Notification failed for ${row.id}:`, notifyErr);
                    }
                }
            }
        } catch (error) {
            console.error('[ExpirationWorker] Error processing expiration sweep:', error);
            throw error;
        } finally {
            client.release();
        }
    }, { connection: connection as any });

    worker.on('failed', (job: any, err: any) => {
        console.error(`[ExpirationWorker] Job ${job?.id} failed:`, err);
    });

    // Schedule repeatable job: every 5 minutes
    expirationQueue.add('sweep-expired', {}, {
        repeat: { every: 5 * 60 * 1000 }, // 5 minutes
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
    }).catch(err => {
        console.error('[ExpirationWorker] Failed to schedule repeatable job:', err);
    });

    console.log('[ExpirationWorker] Started — sweeping expired approvals every 5 minutes');
    return worker;
};
