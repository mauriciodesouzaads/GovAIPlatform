/**
 * Circuit Breaker — FASE 11
 * ---------------------------------------------------------------------------
 * Simple state-machine circuit breaker, one instance per (runtime_slug).
 * Protects the GovAI backend from cascading failures when a runtime is
 * degraded or down.
 *
 * States:
 *   - closed:    normal operation; count consecutive failures
 *   - open:      reject all requests for OPEN_DURATION_MS
 *   - half_open: allow one probe; on success → closed, on failure → open
 *
 * Thresholds (configurable via env):
 *   - CIRCUIT_FAILURE_THRESHOLD (default 5)
 *   - CIRCUIT_OPEN_DURATION_MS (default 30000)
 *
 * Usage in the adapter:
 *
 *   const cb = beforeCall(`runtime:${slug}`);  // throws CircuitOpenError if open
 *   try {
 *       const result = await doWork();
 *       cb.recordSuccess();
 *   } catch (err) {
 *       cb.recordFailure();
 *       throw err;
 *   }
 */

interface BreakerState {
    state: 'closed' | 'open' | 'half_open';
    failureCount: number;
    lastFailureAt: number;
    successCountInHalfOpen: number;
}

const FAILURE_THRESHOLD = parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD || '5', 10);
const OPEN_DURATION_MS = parseInt(process.env.CIRCUIT_OPEN_DURATION_MS || '30000', 10);
const HALF_OPEN_SUCCESS_THRESHOLD = 2;

const breakers = new Map<string, BreakerState>();

function getOrCreate(key: string): BreakerState {
    let b = breakers.get(key);
    if (!b) {
        b = { state: 'closed', failureCount: 0, lastFailureAt: 0, successCountInHalfOpen: 0 };
        breakers.set(key, b);
    }
    return b;
}

export class CircuitOpenError extends Error {
    public readonly code = 'CIRCUIT_OPEN' as const;
    public readonly openUntil: number;
    constructor(public readonly key: string, openUntil: number) {
        super(`Circuit ${key} is open until ${new Date(openUntil).toISOString()}`);
        this.name = 'CircuitOpenError';
        this.openUntil = openUntil;
    }
}

/**
 * Check if the circuit allows a request. Throws CircuitOpenError if open.
 * Returns handles to record success/failure after the request completes.
 */
export function beforeCall(key: string): { recordSuccess: () => void; recordFailure: () => void } {
    const b = getOrCreate(key);
    const now = Date.now();

    // closed/half_open transition: open → half_open after cool-down
    if (b.state === 'open' && now - b.lastFailureAt > OPEN_DURATION_MS) {
        b.state = 'half_open';
        b.successCountInHalfOpen = 0;
    }

    if (b.state === 'open') {
        throw new CircuitOpenError(key, b.lastFailureAt + OPEN_DURATION_MS);
    }

    return {
        recordSuccess: () => {
            if (b.state === 'half_open') {
                b.successCountInHalfOpen++;
                if (b.successCountInHalfOpen >= HALF_OPEN_SUCCESS_THRESHOLD) {
                    b.state = 'closed';
                    b.failureCount = 0;
                    console.log(`[CircuitBreaker] ${key} closed`);
                }
            } else {
                // reset failure count on any success in closed state
                b.failureCount = 0;
            }
        },
        recordFailure: () => {
            b.lastFailureAt = Date.now();
            if (b.state === 'half_open') {
                b.state = 'open';
                console.warn(`[CircuitBreaker] ${key} reopened (half_open probe failed)`);
                return;
            }
            b.failureCount++;
            if (b.failureCount >= FAILURE_THRESHOLD) {
                b.state = 'open';
                console.warn(`[CircuitBreaker] ${key} OPEN after ${b.failureCount} failures`);
            }
        },
    };
}

/**
 * Returns a snapshot of the breaker state (for observability / tests).
 */
export function getBreakerState(key: string): BreakerState {
    return { ...getOrCreate(key) };
}

/**
 * Reset a breaker (for tests or manual recovery). Do NOT call from
 * production code paths — let the state machine do its job.
 */
export function resetBreaker(key: string): void {
    breakers.delete(key);
}
