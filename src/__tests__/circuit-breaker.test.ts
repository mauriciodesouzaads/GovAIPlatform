import { describe, it, expect, beforeEach } from 'vitest';
import { beforeCall, CircuitOpenError, getBreakerState, resetBreaker } from '../lib/circuit-breaker';

describe('Circuit Breaker', () => {
    const key = 'test-runtime-' + Date.now();

    beforeEach(() => {
        resetBreaker(key);
    });

    it('starts in closed state', () => {
        expect(getBreakerState(key).state).toBe('closed');
    });

    it('opens after 5 consecutive failures', () => {
        for (let i = 0; i < 5; i++) {
            const cb = beforeCall(key);
            cb.recordFailure();
        }
        expect(getBreakerState(key).state).toBe('open');
    });

    it('rejects requests when open with CircuitOpenError', () => {
        for (let i = 0; i < 5; i++) {
            beforeCall(key).recordFailure();
        }
        expect(() => beforeCall(key)).toThrow(CircuitOpenError);
    });

    it('resets failure count on success in closed state', () => {
        // Record 3 failures (not enough to open)
        for (let i = 0; i < 3; i++) {
            beforeCall(key).recordFailure();
        }
        expect(getBreakerState(key).failureCount).toBe(3);

        // One success resets
        beforeCall(key).recordSuccess();
        expect(getBreakerState(key).failureCount).toBe(0);
        expect(getBreakerState(key).state).toBe('closed');
    });

    it('CircuitOpenError has code RUNTIME_UNAVAILABLE-style metadata', () => {
        for (let i = 0; i < 5; i++) {
            beforeCall(key).recordFailure();
        }
        try {
            beforeCall(key);
            throw new Error('should have thrown CircuitOpenError');
        } catch (err: any) {
            expect(err).toBeInstanceOf(CircuitOpenError);
            expect(err.code).toBe('CIRCUIT_OPEN');
            expect(err.key).toBe(key);
            expect(err.openUntil).toBeGreaterThan(Date.now());
        }
    });
});
