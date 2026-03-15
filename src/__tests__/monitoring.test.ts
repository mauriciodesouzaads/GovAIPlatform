/**
 * GovAI Platform — Monitoring module tests
 *
 * Verifies that initMonitoring, captureError, and captureMessage are safe to
 * call regardless of whether SENTRY_DSN is set, and that the PII-stripping
 * beforeSend hook works correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() ensures these variables are available when vi.mock() factories
// run (vi.mock is hoisted to the top by Vitest's transformer).
// ---------------------------------------------------------------------------
const { mockInit, mockCaptureException, mockCaptureMessage, mockWithScope } = vi.hoisted(() => ({
    mockInit: vi.fn(),
    mockCaptureException: vi.fn(),
    mockCaptureMessage: vi.fn(),
    mockWithScope: vi.fn((cb: (scope: { setExtra: ReturnType<typeof vi.fn> }) => void) => {
        cb({ setExtra: vi.fn() });
    }),
}));

vi.mock('@sentry/node', () => ({
    init: mockInit,
    captureException: mockCaptureException,
    captureMessage: mockCaptureMessage,
    withScope: mockWithScope,
}));

vi.mock('@sentry/profiling-node', () => ({
    nodeProfilingIntegration: vi.fn(() => ({ name: 'ProfilingIntegration' })),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are declared)
// ---------------------------------------------------------------------------
import { initMonitoring, captureError, captureMessage } from '../lib/monitoring';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Monitoring module', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
        vi.clearAllMocks();
    });

    afterEach(() => {
        process.env = ORIGINAL_ENV;
    });

    // ── Caso 1 ────────────────────────────────────────────────────────────────
    it('Caso 1: initMonitoring() sem SENTRY_DSN — não lança erro, loga aviso', () => {
        delete process.env.SENTRY_DSN;

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => initMonitoring()).not.toThrow();
        expect(mockInit).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SENTRY_DSN'));
        warnSpy.mockRestore();
    });

    // ── Caso 2 ────────────────────────────────────────────────────────────────
    it('Caso 2: initMonitoring() com SENTRY_DSN inválido — não lança erro', () => {
        process.env.SENTRY_DSN = 'https://invalid-dsn@example.ingest.sentry.io/0';

        // Sentry.init is mocked — it won't validate the DSN
        expect(() => initMonitoring()).not.toThrow();
        expect(mockInit).toHaveBeenCalledTimes(1);
        const callArgs = mockInit.mock.calls[0][0] as { dsn: string; environment: string };
        expect(callArgs).toMatchObject({
            dsn: 'https://invalid-dsn@example.ingest.sentry.io/0',
            environment: expect.any(String),
        });
    });

    // ── Caso 3 ────────────────────────────────────────────────────────────────
    it('Caso 3: captureError() funciona sem DSN configurado (mock Sentry)', () => {
        delete process.env.SENTRY_DSN;

        const err = new Error('Test error');
        expect(() => captureError(err)).not.toThrow();
        expect(() => captureError(err, { job: 'test', orgId: 'org-1' })).not.toThrow();
    });

    // ── Caso 4 ────────────────────────────────────────────────────────────────
    it('Caso 4: captureMessage() funciona sem DSN configurado (mock Sentry)', () => {
        delete process.env.SENTRY_DSN;

        expect(() => captureMessage('info message')).not.toThrow();
        expect(() => captureMessage('warning', 'warning')).not.toThrow();
        expect(() => captureMessage('error', 'error')).not.toThrow();
    });

    // ── Caso 5: beforeSend strips PII ─────────────────────────────────────────
    it('Caso 5: beforeSend hook remove request.data (PII protection)', () => {
        process.env.SENTRY_DSN = 'https://key@example.ingest.sentry.io/1';

        initMonitoring();

        // Extract the beforeSend function passed to Sentry.init
        const initOptions = mockInit.mock.calls[0][0] as {
            beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
        };
        const beforeSend = initOptions.beforeSend;
        expect(typeof beforeSend).toBe('function');

        // With request data — data field should be stripped
        const eventWithData: Record<string, unknown> = {
            request: { data: '{"password":"secret","cpf":"000.000.000-00"}' },
        };
        const result = beforeSend(eventWithData) as Record<string, Record<string, unknown>>;
        expect(result?.request?.data).toBeUndefined();

        // Without request data — event must still be returned
        const eventNoData: Record<string, unknown> = {
            message: 'Some error occurred',
        };
        const resultNoData = beforeSend(eventNoData);
        expect(resultNoData).toBeDefined();
        expect(resultNoData).toMatchObject({ message: 'Some error occurred' });
    });
});
