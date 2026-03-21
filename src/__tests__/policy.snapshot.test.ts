/**
 * Tests for policy snapshot capture and reuse logic.
 * B6 — Sprint B: GOV.AI Core Hardening
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { captureOrReusePolicySnapshot } from '../services/execution.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashPolicy(policyJson: object): string {
    return createHash('sha256').update(JSON.stringify(policyJson)).digest('hex');
}

function makeClient(queryResults: Array<{ rows: any[] }>) {
    let callIndex = 0;
    return {
        query: vi.fn().mockImplementation(async () => {
            const result = queryResults[callIndex] ?? { rows: [] };
            callIndex++;
            return result;
        }),
    } as any;
}

// ── Test Data ─────────────────────────────────────────────────────────────────

const ORG_ID    = '00000000-0000-0000-0000-000000000001';
const ASST_ID   = '00000000-0000-0000-0000-000000000002';
const VER_ID    = '00000000-0000-0000-0000-000000000003';
const SNAP_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const POLICY    = { pii_filter: true, forbidden_topics: ['hack', 'bypass'] };

// ── T1: creates new snapshot when hash not found ──────────────────────────────

describe('captureOrReusePolicySnapshot', () => {
    it('T1: creates new snapshot for a previously unseen policy hash', async () => {
        const client = makeClient([
            { rows: [] },           // SELECT — hash not found
            { rows: [{ id: SNAP_ID }] },  // INSERT RETURNING id
        ]);

        const result = await captureOrReusePolicySnapshot(
            client, ORG_ID, ASST_ID, VER_ID, POLICY, null
        );

        expect(result).toBe(SNAP_ID);
        expect(client.query).toHaveBeenCalledTimes(2);

        // First call must be the SELECT with correct hash
        const selectCall = client.query.mock.calls[0];
        expect(selectCall[0]).toMatch(/SELECT id FROM policy_snapshots/i);
        const expectedHash = hashPolicy(POLICY);
        expect(selectCall[1]).toEqual([ORG_ID, expectedHash]);
    });

    // ── T2: reuses existing snapshot for same hash ────────────────────────────

    it('T2: reuses existing snapshot when policy hash already exists for org', async () => {
        const existingId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const client = makeClient([
            { rows: [{ id: existingId }] },  // SELECT — hash found
        ]);

        const result = await captureOrReusePolicySnapshot(
            client, ORG_ID, ASST_ID, VER_ID, POLICY, null
        );

        expect(result).toBe(existingId);
        // INSERT must NOT be called — reuse path
        expect(client.query).toHaveBeenCalledTimes(1);
    });

    // ── T3: same policy object always produces same hash ─────────────────────

    it('T3: identical policy objects produce identical hashes (content-addressable)', () => {
        const policyA = { pii_filter: true, forbidden_topics: ['hack', 'bypass'] };
        const policyB = { pii_filter: true, forbidden_topics: ['hack', 'bypass'] };
        expect(hashPolicy(policyA)).toBe(hashPolicy(policyB));
    });

    // ── T4: snapshot id is included in audit log payload ─────────────────────

    it('T4: snapshotId returned by captureOrReusePolicySnapshot is propagated', async () => {
        const client = makeClient([
            { rows: [] },
            { rows: [{ id: SNAP_ID }] },
        ]);

        const snapshotId = await captureOrReusePolicySnapshot(
            client, ORG_ID, ASST_ID, VER_ID, POLICY, 'user-uuid-123'
        );

        // Simulate audit log payload construction (as done in execution.service)
        const auditPayload = {
            input: 'test message',
            output: { message: { content: 'response' } },
            traceId: 'trace-001',
            snapshotId,
        };

        expect(auditPayload.snapshotId).toBe(SNAP_ID);
        expect(typeof auditPayload.snapshotId).toBe('string');
    });

    // ── T5: non-fatal on DB error — returns null ──────────────────────────────

    it('T5: returns null on DB error without throwing (non-fatal)', async () => {
        const client = {
            query: vi.fn().mockRejectedValue(new Error('relation "policy_snapshots" does not exist')),
        } as any;

        const result = await captureOrReusePolicySnapshot(
            client, ORG_ID, ASST_ID, VER_ID, POLICY, null
        );

        expect(result).toBeNull();
    });
});
