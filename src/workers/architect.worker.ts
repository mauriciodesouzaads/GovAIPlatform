/**
 * Architect BullMQ Worker
 *
 * Handles async dispatch of architect work items, primarily for
 * the 'openclaude' execution_hint which involves a long-running gRPC stream.
 *
 * Concurrency: 2 (max 2 simultaneous OpenClaude runs per API instance)
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { dispatchWorkItem } from '../lib/architect-delegation';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const architectQueue = new Queue('architect-dispatch', {
    connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
    },
});

export interface ArchitectDispatchPayload {
    orgId: string;
    workItemId: string;
}

export function initArchitectWorker(pgPool: Pool): Worker {
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any;

    const worker = new Worker<ArchitectDispatchPayload>(
        'architect-dispatch',
        async (job: Job<ArchitectDispatchPayload>) => {
            const { orgId, workItemId } = job.data;
            console.log(`[Architect Worker] Dispatching work item ${workItemId} for org ${orgId}`);

            const result = await dispatchWorkItem(pgPool, orgId, workItemId);
            console.log(`[Architect Worker] Completed: adapter=${result.adapter} success=${result.success}`);
            return result;
        },
        {
            connection,
            concurrency: 2, // max 2 concurrent OpenClaude runs
            lockDuration: 360_000, // 6 min lock (> OpenClaude timeout)
        }
    );

    worker.on('completed', (job) => {
        console.log(`[Architect Worker] Job ${job.id} completed successfully`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[Architect Worker] Job ${job?.id} failed: ${err?.message}`);
    });

    worker.on('error', (err) => {
        console.error(`[Architect Worker] Worker error:`, err?.message);
    });

    console.log('[Architect Worker] Started');
    return worker;
}
