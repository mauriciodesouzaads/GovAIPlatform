import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

/**
 * Initialises Sentry error monitoring.
 * Safe to call when SENTRY_DSN is absent — monitoring simply stays disabled.
 * Must be called before any Fastify routes or workers are registered.
 */
export function initMonitoring(): void {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
        console.warn('[Monitoring] SENTRY_DSN não configurado — monitoramento desativado');
        return;
    }

    Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || 'development',
        release: process.env.npm_package_version,
        integrations: [nodeProfilingIntegration()],
        // Collect 10 % of transactions in production; 100 % locally
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        profilesSampleRate: 0.1,
        beforeSend(event) {
            // Never forward request bodies — they may contain PII / credentials
            if (event.request?.data) {
                delete event.request.data;
            }
            return event;
        },
    });

    console.log('[Monitoring] Sentry inicializado — environment:', process.env.NODE_ENV);
}

/**
 * Reports an Error to Sentry with optional structured context.
 * No-op when Sentry has not been initialised (no DSN).
 */
export function captureError(
    error: Error,
    context?: Record<string, unknown>,
): void {
    if (context) {
        Sentry.withScope((scope) => {
            Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
            Sentry.captureException(error);
        });
    } else {
        Sentry.captureException(error);
    }
}

/**
 * Sends an informational message to Sentry.
 * No-op when Sentry has not been initialised (no DSN).
 */
export function captureMessage(
    message: string,
    level: Sentry.SeverityLevel = 'info',
): void {
    Sentry.captureMessage(message, level);
}

export { Sentry };
