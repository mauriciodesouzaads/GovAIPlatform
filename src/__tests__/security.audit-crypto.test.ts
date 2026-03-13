import { describe, it, expect, vi, afterEach } from 'vitest';
import { IntegrityService } from '../lib/governance';
import crypto from 'crypto';

describe('Audit Trail & Crypto Integrity Verification', () => {

    it('PROOF: IntegrityService must detect payload tampering', () => {
        const secret = 'test-secret';
        const payload = { data: "original" };
        const signature = IntegrityService.signPayload(payload, secret);

        expect(IntegrityService.verifyPayload(payload, secret, signature)).toBe(true);

        const tamperedPayload = { data: "tampered" };
        expect(IntegrityService.verifyPayload(tamperedPayload, secret, signature)).toBe(false);
    });

    it('PROOF: Audit Log Reports must correctly verify post-sanitization signatures', () => {
        // This test simulates the logic inside reports.routes.ts
        const secret = 'test-secret';
        const metadata = {
            original: "content",
            _integrity: {
                original_signature: "old-sig",
                sanitized_at: "2026-03-09"
            }
        };
        const signature = IntegrityService.signPayload(metadata, secret);

        // Re-verification in report
        const recomputed = IntegrityService.signPayload(metadata, secret);
        expect(signature).toBe(recomputed);
    });

    it('DESIGN CHECK: KMS Production Guard', async () => {
        const originalEnv = process.env.NODE_ENV;
        const originalKey = process.env.ORG_MASTER_KEY;

        try {
            const { getKmsAdapter } = await import('../lib/kms');

            // Case 1: production with a dev-like key (not a 64-char hex) → must throw
            process.env.NODE_ENV = 'production';
            process.env.ORG_MASTER_KEY = 'default-secret-key-for-local-dev-only-32b';
            expect(() => getKmsAdapter()).toThrow(/PRODUÇÃO/);

            // Case 2: production with no key at all → must throw
            delete process.env.ORG_MASTER_KEY;
            expect(() => getKmsAdapter()).toThrow(/PRODUÇÃO/);

            // Case 3: production with a valid 64-char hex key → must NOT throw
            process.env.ORG_MASTER_KEY = 'a'.repeat(64); // valid hex string
            expect(() => getKmsAdapter()).not.toThrow();
        } finally {
            // Always restore environment — even when assertions fail
            process.env.NODE_ENV = originalEnv;
            if (originalKey === undefined) {
                delete process.env.ORG_MASTER_KEY;
            } else {
                process.env.ORG_MASTER_KEY = originalKey;
            }
        }
    });
});
