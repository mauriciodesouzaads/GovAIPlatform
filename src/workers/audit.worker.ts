import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import crypto from 'crypto';
import IORedis from 'ioredis';

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

export const auditQueue = new Queue('audit-logs', { connection: connection as any });

export const initAuditWorker = () => {
    const worker = new Worker('audit-logs', async job => {
        const { org_id, assistant_id, action, metadata, signature, traceId } = job.data;

        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            // Verify the signature before inserting to prevent tampering in the queue
            const expectedSignature = crypto.createHmac('sha256', process.env.SIGNING_SECRET!).update(JSON.stringify(metadata)).digest('hex');

            if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
                throw new Error("Assinatura do log de auditoria inválida! Possível adulteração na fila.");
            }

            // Escrita Assíncrona no Banco (com bypass do RLS pois é um processo de sistema)
            await client.query(
                `INSERT INTO audit_logs_partitioned (org_id, assistant_id, action, metadata, signature) VALUES (\$1, \$2, \$3, \$4, \$5)`,
                [org_id, assistant_id, action, JSON.stringify(metadata), signature]
            );

            await client.query('COMMIT');
            console.log(`[Worker] Audit log processed successfully for traceId: ${traceId}`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`[Worker] Error processing audit log for traceId: ${traceId}`, error);
            throw error; // Will be retried by BullMQ based on job settings
        } finally {
            client.release();
        }
    }, { connection: connection as any });

    worker.on('failed', (job: any, err: any) => {
        console.error(`[Worker] Job ${job.id} failed with error:`, err);
    });

    return worker;
};
