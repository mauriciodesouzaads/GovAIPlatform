"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAuditWorker = exports.auditQueue = void 0;
const bullmq_1 = require("bullmq");
const pg_1 = require("pg");
const crypto_1 = __importDefault(require("crypto"));
const ioredis_1 = __importDefault(require("ioredis"));
const pgPool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
const connection = new ioredis_1.default(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});
exports.auditQueue = new bullmq_1.Queue('audit-logs', { connection: connection });
const initAuditWorker = () => {
    const worker = new bullmq_1.Worker('audit-logs', async (job) => {
        const { org_id, assistant_id, action, metadata, signature, traceId } = job.data;
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            // Verify the signature before inserting to prevent tampering in the queue
            const expectedSignature = crypto_1.default.createHmac('sha256', process.env.SIGNING_SECRET).update(JSON.stringify(metadata)).digest('hex');
            if (!crypto_1.default.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
                throw new Error("Assinatura do log de auditoria inválida! Possível adulteração na fila.");
            }
            // Escrita Assíncrona no Banco (com bypass do RLS pois é um processo de sistema)
            await client.query(`INSERT INTO audit_logs_partitioned (org_id, assistant_id, action, metadata, signature) VALUES (\$1, \$2, \$3, \$4, \$5)`, [org_id, assistant_id, action, JSON.stringify(metadata), signature]);
            await client.query('COMMIT');
            console.log(`[Worker] Audit log processed successfully for traceId: ${traceId}`);
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error(`[Worker] Error processing audit log for traceId: ${traceId}`, error);
            throw error; // Will be retried by BullMQ based on job settings
        }
        finally {
            client.release();
        }
    }, { connection: connection });
    worker.on('failed', (job, err) => {
        console.error(`[Worker] Job ${job.id} failed with error:`, err);
    });
    return worker;
};
exports.initAuditWorker = initAuditWorker;
