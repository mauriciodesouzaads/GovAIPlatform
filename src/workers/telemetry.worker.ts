import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import axios from 'axios';
import { telemetryQueueDepth } from '../lib/sre-metrics';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

connection.on('error', (err) => {
    console.error('[Telemetry Worker] Redis connection error:', err.message);
});

export const telemetryQueue = new Queue('telemetry', { connection: connection as any });

// Atualiza a gauge de profundidade com o backlog real (waiting + delayed).
// Executado após cada job concluído ou falhado para manter o Prometheus atualizado.
async function refreshTelemetryDepth(): Promise<void> {
    try {
        const counts = await telemetryQueue.getJobCounts('waiting', 'delayed');
        telemetryQueueDepth.set((counts.waiting ?? 0) + (counts.delayed ?? 0));
    } catch {
        // Falha silenciosa — a gauge permanece com o último valor conhecido
    }
}

export function initTelemetryWorker() {
    const worker = new Worker('telemetry', async (job) => {
        const {
            org_id,
            assistant_id,
            traceId,
            tokens,
            cost,
            latency_ms,
            model,
            prompt,
            completion,
            pii_stripped,
        } = job.data;

        // Modo mock para testes — evita chamadas de rede quando chave é dummy
        const langfusePk = process.env.LANGFUSE_PUBLIC_KEY || 'pk-lf-dummy';
        if (langfusePk === 'pk-lf-dummy') {
            console.log(`[Telemetry/Mock] traceId=${traceId} latency=${latency_ms}ms tokens=${tokens?.total_tokens ?? 0}`);
            return;
        }

        const langfuseUrl = process.env.LANGFUSE_URL || 'https://cloud.langfuse.com';
        const langfuseSk = process.env.LANGFUSE_SECRET_KEY || '';

        if (!langfuseSk) {
            console.error('[Telemetry] LANGFUSE_SECRET_KEY não configurado. Abortando envio.');
            return;
        }

        // Construção do payload — prompt e completion são null quando pii_strip=true
        // (consentimento granular: o tenant optou por enviar apenas métricas)
        const generationPayload: Record<string, unknown> = {
            type: 'generation',
            id: traceId,
            timestamp: new Date().toISOString(),
            model: model || 'govai-llm',
            usage: {
                promptTokens: tokens?.prompt_tokens || 0,
                completionTokens: tokens?.completion_tokens || 0,
                totalCost: cost || 0,
            },
            metadata: {
                org_id,
                assistant_id,
                latency_ms,
                pii_stripped: pii_stripped ?? true,
            },
        };

        if (!pii_stripped) {
            // Somente inclui conteúdo textual quando o tenant optou por telemetria completa
            generationPayload.input = prompt;
            generationPayload.output = completion;
        } else {
            // Telemetria agregada: inclui apenas estrutura (sem texto)
            generationPayload.input = '[PII_STRIPPED]';
            generationPayload.output = '[PII_STRIPPED]';
        }

        await axios.post(
            `${langfuseUrl}/api/public/ingestion`,
            { batch: [generationPayload] },
            {
                headers: {
                    Authorization: `Basic ${Buffer.from(`${langfusePk}:${langfuseSk}`).toString('base64')}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10_000,
            }
        );

        console.log(`[Telemetry] Exported to Langfuse: traceId=${traceId} pii_stripped=${pii_stripped ?? true}`);

    }, { connection: connection as any });

    worker.on('completed', () => { void refreshTelemetryDepth(); });
    worker.on('failed', (job, err) => {
        console.error(`[Telemetry Worker] Job ${job?.id} failed:`, err.message);
        void refreshTelemetryDepth();
    });

    // Popula a gauge imediatamente ao iniciar o worker
    void refreshTelemetryDepth();

    return worker;
}
