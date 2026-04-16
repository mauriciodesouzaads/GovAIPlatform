/**
 * Structured logging helpers — FASE 10
 * ---------------------------------------------------------------------------
 * JSON format with canonical fields for Loki/Elastic queryability and
 * correlation with OpenTelemetry traces.
 *
 * Canonical fields (always present when available):
 *   - trace_id:      x-govai-trace-id UUID (internal, per-request)
 *   - otel_trace_id: OpenTelemetry trace_id (for cross-system correlation)
 *   - otel_span_id:  current span within the trace
 *   - org_id:        tenant identifier
 *   - user_id:       acting user (if authenticated)
 *   - component:     logical subsystem (gateway, dlp, approval_bridge, runtime, ...)
 *   - outcome:       success | failure | blocked | pending
 */

export interface LogContext {
    trace_id?: string;
    org_id?: string;
    user_id?: string;
    component: string;
    outcome?: 'success' | 'failure' | 'blocked' | 'pending';
    [key: string]: unknown;
}

/**
 * Enrich a log context with OTel span information (when a span is active).
 * Safe to call even when OTel is disabled — returns the context unchanged.
 */
export function enrichLog(ctx: LogContext): Record<string, unknown> {
    let otelTraceId: string | undefined;
    let otelSpanId: string | undefined;
    try {
        // Dynamic require so the module is never loaded when OTel deps are absent
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { trace } = require('@opentelemetry/api');
        const spanCtx = trace.getActiveSpan()?.spanContext();
        otelTraceId = spanCtx?.traceId;
        otelSpanId = spanCtx?.spanId;
    } catch {
        // OTel not installed — ok
    }
    return {
        ...ctx,
        otel_trace_id: otelTraceId,
        otel_span_id: otelSpanId,
    };
}

/**
 * Write a structured log event. In production, outputs JSON to stdout
 * (compatible with any log shipper). In dev, uses console.log with
 * a human-readable prefix.
 */
export function logEvent(ctx: LogContext, message: string): void {
    const enriched = enrichLog(ctx);
    const payload = { ...enriched, msg: message, time: new Date().toISOString() };
    if (process.env.NODE_ENV === 'production') {
        process.stdout.write(JSON.stringify(payload) + '\n');
    } else {
        console.log(`[${ctx.component}] ${message}`, JSON.stringify(enriched));
    }
}
