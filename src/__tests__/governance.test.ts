import { describe, it, expect } from 'vitest';
import { IntegrityService, GovernanceRequestSchema, ActionType } from '../lib/governance';

describe('IntegrityService', () => {

    const secret = 'test-secret-key-for-hmac-sha256-signing';

    describe('signPayload', () => {
        it('should produce a consistent HMAC-SHA256 for the same payload and secret', () => {
            const payload = { action: 'EXECUTION', message: 'Hello' };
            const sig1 = IntegrityService.signPayload(payload, secret);
            const sig2 = IntegrityService.signPayload(payload, secret);
            expect(sig1).toBe(sig2);
            expect(sig1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex = 64 chars
        });

        it('should produce different signatures for different payloads', () => {
            const sig1 = IntegrityService.signPayload({ msg: 'a' }, secret);
            const sig2 = IntegrityService.signPayload({ msg: 'b' }, secret);
            expect(sig1).not.toBe(sig2);
        });

        it('should produce different signatures for different secrets', () => {
            const payload = { action: 'test' };
            const sig1 = IntegrityService.signPayload(payload, 'secret-1');
            const sig2 = IntegrityService.signPayload(payload, 'secret-2');
            expect(sig1).not.toBe(sig2);
        });
    });

    describe('verifyPayload', () => {
        it('should return true for a valid signature', () => {
            const payload = { event: 'audit', value: 42 };
            const signature = IntegrityService.signPayload(payload, secret);
            expect(IntegrityService.verifyPayload(payload, secret, signature)).toBe(true);
        });

        it('should return false for a tampered payload', () => {
            const original = { event: 'audit', value: 42 };
            const signature = IntegrityService.signPayload(original, secret);
            const tampered = { event: 'audit', value: 99 };
            expect(IntegrityService.verifyPayload(tampered, secret, signature)).toBe(false);
        });

        it('should return false for a wrong secret', () => {
            const payload = { event: 'audit' };
            const signature = IntegrityService.signPayload(payload, secret);
            expect(IntegrityService.verifyPayload(payload, 'wrong-secret', signature)).toBe(false);
        });
    });
});

describe('GovernanceRequestSchema', () => {

    it('should accept a valid message', () => {
        const result = GovernanceRequestSchema.safeParse({ message: 'Qual é a política de férias?' });
        expect(result.success).toBe(true);
    });

    it('should reject an empty message', () => {
        const result = GovernanceRequestSchema.safeParse({ message: '' });
        expect(result.success).toBe(false);
    });

    it('should reject a message exceeding 10000 characters', () => {
        const result = GovernanceRequestSchema.safeParse({ message: 'x'.repeat(10001) });
        expect(result.success).toBe(false);
    });

    it('should reject missing message field', () => {
        const result = GovernanceRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

describe('ActionType Enum Validation', () => {

    const validActions = [
        'EXECUTION', 'POLICY_VIOLATION', 'EXECUTION_SUCCESS',
        'EXECUTION_ERROR', 'PENDING_APPROVAL', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED'
    ];

    it.each(validActions)('should accept valid action type: %s', (action) => {
        const result = ActionType.safeParse(action);
        expect(result.success).toBe(true);
    });

    it('should reject an invalid action type', () => {
        const result = ActionType.safeParse('DELETE_EVERYTHING');
        expect(result.success).toBe(false);
    });

    it('should reject an empty string', () => {
        const result = ActionType.safeParse('');
        expect(result.success).toBe(false);
    });

    it('should reject lowercase variants (case-sensitive)', () => {
        const result = ActionType.safeParse('execution');
        expect(result.success).toBe(false);
    });
});
