/**
 * OpenTelemetry tracing setup — FASE 10
 *
 * Must be imported BEFORE any instrumented module (fastify, pg, ioredis, etc).
 * server.ts imports this at the very top, before `dotenv/config`.
 *
 * Feature flag: OTEL_ENABLED (default false). When disabled, this module is
 * a no-op — no exporter created, no resource overhead, no SDK initialization.
 *
 * Configuration (env vars):
 *   - OTEL_ENABLED=true              — enable tracing
 *   - OTEL_SERVICE_NAME=govai-api    — default: govai-api
 *   - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces
 *   - OTEL_SERVICE_VERSION=1.0.0     — optional
 *   - OTEL_ENVIRONMENT=production    — tag spans with env
 */

let sdk: any = null;

export function initTracing(): void {
    if (process.env.OTEL_ENABLED !== 'true') {
        return;
    }

    try {
        // Dynamic imports so the modules are never loaded when OTEL is disabled
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { NodeSDK } = require('@opentelemetry/sdk-node');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Resource } = require('@opentelemetry/resources');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT } = require('@opentelemetry/semantic-conventions');

        const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318/v1/traces';
        const serviceName = process.env.OTEL_SERVICE_NAME || 'govai-api';

        sdk = new NodeSDK({
            resource: new Resource({
                [ATTR_SERVICE_NAME]: serviceName,
                [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || '1.0.0',
                [ATTR_DEPLOYMENT_ENVIRONMENT || 'deployment.environment']: process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'development',
            }),
            traceExporter: new OTLPTraceExporter({ url: endpoint }),
            instrumentations: [
                getNodeAutoInstrumentations({
                    // Disable fs instrumentation (too noisy for our use case)
                    '@opentelemetry/instrumentation-fs': { enabled: false },
                    // DNS creates many low-signal spans
                    '@opentelemetry/instrumentation-dns': { enabled: false },
                    // Keep: http, pg, ioredis, fastify, grpc
                }),
            ],
        });

        sdk.start();
        console.log(`[OTel] Tracing started → ${endpoint} (service=${serviceName})`);
    } catch (err) {
        console.error('[OTel] Failed to start SDK:', (err as Error).message);
    }
}

export async function shutdownTracing(): Promise<void> {
    if (!sdk) return;
    try {
        await sdk.shutdown();
        console.log('[OTel] Tracing shut down');
    } catch (err) {
        console.error('[OTel] Shutdown error:', (err as Error).message);
    }
}
