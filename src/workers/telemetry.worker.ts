import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import axios from 'axios';
import { randomUUID } from 'crypto';
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

interface TelemetrySpan {
    name: string;
    type: 'span' | 'generation';
    startTime: string;
    endTime: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
}

export function initTelemetryWorker() {
    const worker = new Worker('telemetry', async (job) => {
        const {
            org_id,
            assistant_id,
            traceId,
            traceName,
            spans,
            totalLatency,
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
            const spansCount = Array.isArray(spans) ? spans.length : 0;
            console.log(
                `[Telemetry/Mock] traceId=${traceId} traceName=${traceName ?? 'n/a'} ` +
                `spans=${spansCount} totalLatency=${totalLatency ?? latency_ms ?? 0}ms ` +
                `tokens=${tokens?.total_tokens ?? 0}`
            );
            return;
        }

        const langfuseUrl = process.env.LANGFUSE_URL || 'https://cloud.langfuse.com';
        const langfuseSk = process.env.LANGFUSE_SECRET_KEY || '';

        if (!langfuseSk) {
            console.error('[Telemetry] LANGFUSE_SECRET_KEY não configurado. Abortando envio.');
            return;
        }

        const authHeader = `Basic ${Buffer.from(`${langfusePk}:${langfuseSk}`).toString('base64')}`;
        const now = new Date().toISOString();

        // ── Trace hierarchy (new 'export-trace' format) ────────────────────────────
        // When spans are present send trace-create + span/generation events in one batch.
        if (Array.isArray(spans) && spans.length > 0) {
            const batch: Array<Record<string, unknown>> = [];

            // 1. trace-create
            batch.push({
                type: 'trace-create',
                id: randomUUID(),
                timestamp: now,
                body: {
                    id: traceId,
                    name: traceName || `execution-${assistant_id}`,
                    metadata: {
                        org_id,
                        assistant_id,
                        total_latency_ms: totalLatency,
                        pii_stripped: pii_stripped ?? true,
                    },
                },
            });

            // 2. span/generation event per collected span
            for (const span of spans as TelemetrySpan[]) {
                const eventType = span.type === 'generation' ? 'generation-create' : 'span-create';
                const body: Record<string, unknown> = {
                    id: randomUUID(),
                    traceId,
                    name: span.name,
                    startTime: span.startTime,
                    endTime: span.endTime,
                    metadata: span.metadata ?? {},
                };

                if (span.type === 'generation') {
                    body.model = model || 'govai-llm';
                    body.input = span.input;
                    body.output = span.output;
                    if (tokens && !body.usage) {
                        body.usage = {
                            promptTokens: tokens.prompt_tokens || 0,
                            completionTokens: tokens.completion_tokens || 0,
                            totalCost: cost || 0,
                        };
                    }
                }

                if (span.input !== undefined && span.type !== 'generation') {
                    body.input = span.input;
                }
                if (span.output !== undefined && span.type !== 'generation') {
                    body.output = span.output;
                }

                batch.push({ type: eventType, id: randomUUID(), timestamp: now, body });
            }

            await axios.post(
                `${langfuseUrl}/api/public/ingestion`,
                { batch },
                {
                    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
                    timeout: 10_000,
                }
            );

            console.log(
                `[Telemetry] Exported trace to Langfuse: traceId=${traceId} ` +
                `spans=${spans.length} pii_stripped=${pii_stripped ?? true}`
            );
            return;
        }

        // ── Legacy single-generation fallback (backward compat) ───────────────────
        // Used when no spans are present (old job format or jobs enqueued before upgrade).
        const generationPayload: Record<string, unknown> = {
            type: 'generation',
            id: traceId,
            timestamp: now,
            model: model || 'govai-llm',
            usage: {
                promptTokens: tokens?.prompt_tokens || 0,
                completionTokens: tokens?.completion_tokens || 0,
                totalCost: cost || 0,
            },
            metadata: {
                org_id,
                assistant_id,
                latency_ms: latency_ms ?? totalLatency,
                pii_stripped: pii_stripped ?? true,
            },
        };

        if (!pii_stripped) {
            generationPayload.input = prompt;
            generationPayload.output = completion;
        } else {
            generationPayload.input = '[PII_STRIPPED]';
            generationPayload.output = '[PII_STRIPPED]';
        }

        await axios.post(
            `${langfuseUrl}/api/public/ingestion`,
            { batch: [generationPayload] },
            {
                headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
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
