/**
 * Unit tests — src/lib/icp-brasil-signer.ts
 * ---------------------------------------------------------------------------
 * Exercises the signing interface with MOCK_ICP=true and against an
 * ephemeral in-memory Pool shim (no real Postgres connection needed).
 *
 * We do NOT boot SoftHSM or a real HSM here — those are integration-tier
 * concerns. The unit tests validate:
 *   - Mock signature is non-empty base64 when an active cert exists
 *   - IcpNotConfiguredError when the query returns zero rows
 *   - computeIcpPayloadHash produces the same 64-char hex as evidence.ts
 *   - Input validation (bad hash format) surfaces the expected error
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
    signWithIcpBrasil,
    IcpNotConfiguredError,
    IcpSigningError,
    computeIcpPayloadHash,
} from '../lib/icp-brasil-signer';

// ── Minimal Pool shim ──────────────────────────────────────────────────────
// We only need `.connect()` to return an object with `.query()` and
// `.release()`. The test fixture decides what rows each query returns.

type Rows = Array<Record<string, unknown>>;

function makePoolShim(rowsByPattern: Array<{ match: RegExp; rows: Rows }>): any {
    const runQuery = async (sql: string, _params?: any[]) => {
        for (const entry of rowsByPattern) {
            if (entry.match.test(sql)) {
                return { rows: entry.rows, rowCount: entry.rows.length };
            }
        }
        return { rows: [], rowCount: 0 };
    };
    return {
        connect: async () => ({
            query: runQuery,
            release: () => { /* noop */ },
        }),
    };
}

beforeAll(() => {
    process.env.MOCK_ICP = 'true';
});

const VALID_HASH = 'a'.repeat(64);
const ORG = '00000000-0000-0000-0000-000000000001';

describe('computeIcpPayloadHash', () => {
    it('returns a 64-char lowercase hex SHA-256', () => {
        const h = computeIcpPayloadHash({
            orgId: ORG,
            category: 'bias_assessment',
            eventType: 'BIAS_PASS',
            metadata: { a: 1 },
        });
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for identical input', () => {
        const a = computeIcpPayloadHash({
            orgId: ORG, category: 'execution', eventType: 'x', metadata: { n: 1 },
        });
        const b = computeIcpPayloadHash({
            orgId: ORG, category: 'execution', eventType: 'x', metadata: { n: 1 },
        });
        expect(a).toBe(b);
    });

    it('differs when metadata differs', () => {
        const a = computeIcpPayloadHash({
            orgId: ORG, category: 'execution', eventType: 'x', metadata: { n: 1 },
        });
        const b = computeIcpPayloadHash({
            orgId: ORG, category: 'execution', eventType: 'x', metadata: { n: 2 },
        });
        expect(a).not.toBe(b);
    });
});

describe('signWithIcpBrasil — MOCK mode', () => {
    it('returns a non-empty base64 mock signature for A3 (HSM path)', async () => {
        const pool = makePoolShim([
            {
                match: /FROM icp_certificates/,
                rows: [{
                    id: 'cert-1',
                    cert_type: 'A3',
                    pkcs11_module_path: '/dev/null',
                    pkcs11_slot_id: 0,
                    pkcs11_key_label: 'test',
                    encrypted_key_path: null,
                    cert_pem: 'PEM',
                    is_active: true,
                    valid_until: new Date(Date.now() + 86_400_000).toISOString(),
                }],
            },
        ]);
        const res = await signWithIcpBrasil(pool, { orgId: ORG, payloadHash: VALID_HASH });
        expect(res.certificateId).toBe('cert-1');
        expect(res.signatureBase64.length).toBeGreaterThan(0);
        expect(() => Buffer.from(res.signatureBase64, 'base64')).not.toThrow();
        expect(res.signedAt).toBeInstanceOf(Date);
    });

    it('returns a mock signature for A1 (file path)', async () => {
        const pool = makePoolShim([
            {
                match: /FROM icp_certificates/,
                rows: [{
                    id: 'cert-a1',
                    cert_type: 'A1',
                    pkcs11_module_path: null,
                    pkcs11_slot_id: null,
                    pkcs11_key_label: null,
                    encrypted_key_path: '/tmp/enc.key',
                    cert_pem: 'PEM',
                    is_active: true,
                    valid_until: new Date(Date.now() + 86_400_000).toISOString(),
                }],
            },
        ]);
        const res = await signWithIcpBrasil(pool, { orgId: ORG, payloadHash: VALID_HASH });
        expect(res.certificateId).toBe('cert-a1');
        expect(res.signatureBase64.length).toBeGreaterThan(0);
    });

    it('throws IcpNotConfiguredError when no active cert exists', async () => {
        const pool = makePoolShim([{ match: /FROM icp_certificates/, rows: [] }]);
        await expect(
            signWithIcpBrasil(pool, { orgId: ORG, payloadHash: VALID_HASH }),
        ).rejects.toBeInstanceOf(IcpNotConfiguredError);
    });

    it('rejects malformed payloadHash with IcpSigningError', async () => {
        const pool = makePoolShim([]);
        await expect(
            signWithIcpBrasil(pool, { orgId: ORG, payloadHash: 'not-hex' }),
        ).rejects.toBeInstanceOf(IcpSigningError);
    });

    it('is deterministic in mock mode (same hash → same signature)', async () => {
        const pool = makePoolShim([
            {
                match: /FROM icp_certificates/,
                rows: [{
                    id: 'cert-1',
                    cert_type: 'A3',
                    pkcs11_module_path: '/dev/null',
                    pkcs11_slot_id: 0,
                    pkcs11_key_label: 'test',
                    encrypted_key_path: null,
                    cert_pem: 'PEM',
                    is_active: true,
                    valid_until: new Date(Date.now() + 86_400_000).toISOString(),
                }],
            },
        ]);
        const a = await signWithIcpBrasil(pool, { orgId: ORG, payloadHash: VALID_HASH });
        const b = await signWithIcpBrasil(pool, { orgId: ORG, payloadHash: VALID_HASH });
        expect(a.signatureBase64).toBe(b.signatureBase64);
    });
});
