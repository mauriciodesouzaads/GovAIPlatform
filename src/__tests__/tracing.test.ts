import { describe, it, expect } from 'vitest';

describe('OpenTelemetry tracing', () => {
    it('has tracer API available (even without SDK initialized)', async () => {
        const { trace } = await import('@opentelemetry/api');
        const tracer = trace.getTracer('test');
        expect(tracer).toBeDefined();
        const span = tracer.startSpan('test-span');
        expect(span).toBeDefined();
        span.end();
    });

    it('initTracing is a no-op when OTEL_ENABLED is not true', async () => {
        const orig = process.env.OTEL_ENABLED;
        delete process.env.OTEL_ENABLED;
        const { initTracing } = await import('../lib/tracing');
        // Should not throw
        initTracing();
        process.env.OTEL_ENABLED = orig;
    });
});
