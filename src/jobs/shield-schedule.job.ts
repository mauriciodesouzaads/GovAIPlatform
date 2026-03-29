/**
 * GovAI Platform — Shield Schedule Job
 *
 * Registers 5 repeatable BullMQ jobs on the 'shield-collection' queue.
 * The shield.worker.ts Worker processes these jobs.
 *
 * Schedule:
 *   generate-findings  every hour           (0 * * * *)
 *   dedupe-findings    every 6 hours        (0 *\/6 * * *)
 *   posture-snapshot   every 12 hours       (0 *\/12 * * *)
 *   collect-oauth      daily at 02:00 BRT   (0 2 * * *)
 *   collect-google     daily at 03:00 BRT   (0 3 * * *)
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// ── Cron schedules ─────────────────────────────────────────────────────────────

const CRON_GENERATE_FINDINGS = '0 * * * *';     // every hour
const CRON_DEDUPE_FINDINGS   = '0 */6 * * *';   // every 6 hours
const CRON_POSTURE_SNAPSHOT  = '0 */12 * * *';  // every 12 hours
const CRON_COLLECT_OAUTH     = '0 2 * * *';     // daily at 02:00
const CRON_COLLECT_GOOGLE    = '0 3 * * *';     // daily at 03:00

// ── Redis connection ──────────────────────────────────────────────────────────

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

connection.on('error', (err) => {
    console.error('[ShieldSchedule] Redis connection error:', err);
});

export const shieldQueue = new Queue('shield-collection', { connection: connection as any });

// ── Schedule bootstrap ────────────────────────────────────────────────────────

export function startShieldSchedule(): void {
    const jobs = [
        { name: 'generate-findings' as const, cron: CRON_GENERATE_FINDINGS },
        { name: 'dedupe-findings'   as const, cron: CRON_DEDUPE_FINDINGS   },
        { name: 'posture-snapshot'  as const, cron: CRON_POSTURE_SNAPSHOT  },
        { name: 'collect-oauth'     as const, cron: CRON_COLLECT_OAUTH     },
        { name: 'collect-google'    as const, cron: CRON_COLLECT_GOOGLE    },
    ];

    for (const { name, cron } of jobs) {
        shieldQueue.add(name, {}, {
            repeat: { pattern: cron },
            removeOnComplete: { count: 10 },
            removeOnFail: { count: 50 },
        }).catch(err => {
            console.error(`[ShieldSchedule] Failed to schedule ${name}:`, err);
        });
    }

    console.log('[ShieldSchedule] 5 shield jobs scheduled');
}
