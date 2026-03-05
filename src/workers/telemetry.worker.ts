import { Worker, Queue } from 'bullmq';
import { Pool } from 'pg';
import axios from 'axios';

const redisConfigUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
    host: redisConfigUrl.hostname,
    port: parseInt(redisConfigUrl.port || '6379'),
    maxRetriesPerRequest: null
};

export const telemetryQueue = new Queue('telemetry', { connection });

export function initTelemetryWorker(pgPool: Pool) {
    const worker = new Worker('telemetry', async job => {
        const { org_id, assistant_id, traceId, tokens, cost, latency_ms } = job.data;

        // 1. Send To Langfuse (Delegated Observability)
        try {
            const langfuseUrl = process.env.LANGFUSE_URL || 'https://cloud.langfuse.com';
            const langfusePk = process.env.LANGFUSE_PUBLIC_KEY || 'pk-lf-dummy';
            const langfuseSk = process.env.LANGFUSE_SECRET_KEY || 'sk-lf-dummy';

            // Prevent actual network dispatch in tests if dummy key is present
            if (langfusePk === 'pk-lf-dummy') {
                console.log(`[Telemetry/Mock] Metrics logged for traceId: ${traceId} (Latency: ${latency_ms}ms)`);
                return;
            }

            // Fire-and-forget payload to Langfuse
            await axios.post(`${langfuseUrl}/api/public/ingestion`, {
                batch: [{
                    type: 'generation',
                    id: traceId,
                    timestamp: new Date().toISOString(),
                    model: job.data.model || 'gemini-1.5-flash',
                    usage: {
                        promptTokens: tokens?.prompt || 0,
                        completionTokens: tokens?.completion || 0,
                        totalCost: cost || 0
                    },
                    metadata: {
                        org_id,
                        assistant_id,
                        latency_ms
                    }
                }]
            }, {
                headers: {
                    Authorization: `Basic ${Buffer.from(`${langfusePk}:${langfuseSk}`).toString('base64')}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[Telemetry] Metrics exported to Langfuse for traceId: ${traceId}`);
        } catch (e: any) {
            console.error(`[Telemetry] Failed to export to Langfuse:`, e.message);
        }

    }, { connection });

    worker.on('failed', (job, err) => {
        console.error(`[Telemetry Worker] Job ${job?.id} failed:`, err.message);
    });

    return worker;
}
