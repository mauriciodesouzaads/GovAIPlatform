import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import crypto from 'crypto';
import { CryptoService } from '../lib/crypto-service';
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

            // 1. Setup clean metadata and encrypt payloads
            let safeMetadata = { ...metadata };
            let runPayloadStr = '';

            // Extract heavy context
            if (action === 'EXECUTION_SUCCESS' || action === 'PENDING_APPROVAL') {
                const payload = {
                    original_prompt: metadata.input || '',
                    llm_response: metadata.output ? JSON.stringify(metadata.output) : undefined,
                    tools_called: metadata.tools || undefined
                };
                runPayloadStr = JSON.stringify(payload);
                
                delete safeMetadata.input;
                delete safeMetadata.output;
                delete safeMetadata.tools;
            }

            // 2. Insert sanitized audit log
            const auditRes = await client.query(
                `INSERT INTO audit_logs_partitioned (org_id, assistant_id, action, metadata, signature) VALUES (\$1, \$2, \$3, \$4, \$5) RETURNING id`,
                [org_id, assistant_id, action, JSON.stringify(safeMetadata), signature]
            );
            
            const logId = auditRes.rows[0].id;

            // 3. Encrypt and persist massive payload in Caixa Negra
            if (runPayloadStr) {
                // Simulating KMS Master Key fetch per org (must be 32 bytes)
                const kmsKey = process.env.ORG_MASTER_KEY || crypto.createHash('sha256').update(org_id).digest('hex').substring(0, 32);
                const cryptoService = new CryptoService(kmsKey);
                
                const { content_encrypted_bytes, iv_bytes, auth_tag_bytes } = cryptoService.encryptPayload(runPayloadStr);
                
                await client.query(
                    `INSERT INTO run_content_encrypted (run_id, org_id, iv_bytes, auth_tag_bytes, content_encrypted_bytes)
                     VALUES (\$1, \$2, \$3, \$4, \$5)`,
                    [logId, org_id, iv_bytes, auth_tag_bytes, content_encrypted_bytes]
                );
            }

            await client.query('COMMIT');
            console.log(`[Worker] Audit log & Encrypted run processed for traceId: ${traceId}`);
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
