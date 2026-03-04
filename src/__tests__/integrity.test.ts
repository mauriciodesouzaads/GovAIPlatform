import { describe, it, expect } from 'vitest';
import { IntegrityService } from '../lib/governance';

describe('IntegrityService (HMAC Audit Protection)', () => {
    const defaultSecret = 'dummy-secure-signing-secret-key-32-chars';

    it('should sign and verify an identical payload accurately', () => {
        const payload = { action: 'EXECUTION', traceId: '12345', metadata: { cost: 0.1 } };

        const signature = IntegrityService.signPayload(payload, defaultSecret);
        expect(signature).toBeTypeOf('string');

        const isValid = IntegrityService.verifyPayload(payload, defaultSecret, signature);
        expect(isValid).toBe(true);
    });

    it('should reject verification if payload is tampered with', () => {
        const originalPayload = { action: 'EXECUTION', amount: 100 };
        const signature = IntegrityService.signPayload(originalPayload, defaultSecret);

        // Tamper with payload
        const tamperedPayload = { action: 'EXECUTION', amount: 9999 };
        const isValid = IntegrityService.verifyPayload(tamperedPayload, defaultSecret, signature);
        expect(isValid).toBe(false);
    });

    it('should reject verification if a different secret key is used', () => {
        const payload = { test: true };
        const signature = IntegrityService.signPayload(payload, defaultSecret);

        const hackSecret = 'malicious-hacker-secret-key-32-chars!!!';
        const isValid = IntegrityService.verifyPayload(payload, hackSecret, signature);
        expect(isValid).toBe(false);
    });
});
