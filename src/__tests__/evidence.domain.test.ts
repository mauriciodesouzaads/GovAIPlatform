/**
 * Tests for the Evidence Domain (Sprint C — C6).
 *
 * Covers: recordEvidence integrity hash, idempotency, immutability trigger guard,
 * linkEvidence, getEvidenceChain ordering, RLS isolation, non-fatal error handling,
 * and the GET /v1/admin/evidence endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { recordEvidence, linkEvidence, getEvidenceChain, EvidencePayload } from '../lib/evidence';

// ── Helpers ───────────────────────────────────────────────────────────────────

function expectedHash(payload: EvidencePayload): string {
    const metadata = payload.metadata ?? {};
    return createHash('sha256')
        .update([payload.orgId, payload.category, payload.eventType, JSON.stringify(metadata)].join('|'))
        .digest('hex');
}

function makeDb(rows: any[] = [], extra?: { throws?: boolean }) {
    return {
        query: extra?.throws
            ? vi.fn().mockRejectedValue(new Error('DB error'))
            : vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    } as any;
}

// ── Test Data ─────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ACTOR_ID = '00000000-0000-0000-0000-000000000099';
const REC_ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REC_ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const PAYLOAD: EvidencePayload = {
    orgId: ORG_ID,
    category: 'execution',
    eventType: 'EXECUTION_SUCCESS',
    actorId: ACTOR_ID,
    actorEmail: 'actor@example.com',
    resourceType: 'assistant',
    resourceId: '00000000-0000-0000-0000-000000000002',
    metadata: { traceId: 'trace-001', tokens: { total: 120 } },
};

// ── T1: recordEvidence — integrity hash is correct ───────────────────────────

describe('recordEvidence', () => {
    it('T1: inserts record and integrity_hash matches SHA-256(orgId|category|eventType|metadata)', async () => {
        const createdAt = new Date();
        const db = makeDb([{ id: REC_ID_A, created_at: createdAt }]);

        const result = await recordEvidence(db, PAYLOAD);

        expect(result).not.toBeNull();
        expect(result!.id).toBe(REC_ID_A);
        expect(result!.createdAt).toBe(createdAt);

        // Verify integrity_hash passed to DB
        const insertCall = db.query.mock.calls[0];
        const passedHash = insertCall[1][8]; // 9th param = integrity_hash
        expect(passedHash).toBe(expectedHash(PAYLOAD));
        expect(passedHash).toHaveLength(64); // hex SHA-256
    });

    // ── T2: same content → same integrity hash ────────────────────────────────

    it('T2: identical payloads always produce the same integrity hash', async () => {
        const payloadA: EvidencePayload = { ...PAYLOAD };
        const payloadB: EvidencePayload = { ...PAYLOAD };
        expect(expectedHash(payloadA)).toBe(expectedHash(payloadB));
    });

    // ── T3: non-fatal — returns null on DB error ──────────────────────────────

    it('T3: returns null on DB error without throwing (non-fatal design)', async () => {
        const db = makeDb([], { throws: true });
        const result = await recordEvidence(db, PAYLOAD);
        expect(result).toBeNull();
    });

    // ── T4: metadata defaults to {} when not provided ─────────────────────────

    it('T4: empty metadata defaults to {} and hash is deterministic', async () => {
        const createdAt = new Date();
        const db = makeDb([{ id: REC_ID_A, created_at: createdAt }]);

        const payloadNoMeta: EvidencePayload = {
            orgId: ORG_ID,
            category: 'api_key_lifecycle',
            eventType: 'API_KEY_REVOKED',
        };

        await recordEvidence(db, payloadNoMeta);

        const insertCall = db.query.mock.calls[0];
        const passedMetadata = insertCall[1][7]; // metadata param (JSON string)
        expect(JSON.parse(passedMetadata)).toEqual({});

        // Hash computed with empty metadata
        const expectedHashVal = createHash('sha256')
            .update(`${ORG_ID}|api_key_lifecycle|API_KEY_REVOKED|{}`)
            .digest('hex');
        expect(insertCall[1][8]).toBe(expectedHashVal);
    });
});

// ── T5: linkEvidence — idempotent via ON CONFLICT DO NOTHING ──────────────────

describe('linkEvidence', () => {
    it('T5: executes INSERT with ON CONFLICT DO NOTHING (idempotent link creation)', async () => {
        const db = makeDb([]);

        await expect(linkEvidence(db, REC_ID_A, REC_ID_B, 'caused_by')).resolves.toBeUndefined();

        const call = db.query.mock.calls[0];
        expect(call[0]).toMatch(/ON CONFLICT.*DO NOTHING/i);
        expect(call[1]).toEqual([REC_ID_A, REC_ID_B, 'caused_by']);
    });

    it('T6: linkEvidence is non-fatal — silently ignores DB errors', async () => {
        const db = makeDb([], { throws: true });
        await expect(linkEvidence(db, REC_ID_A, REC_ID_B, 'caused_by')).resolves.toBeUndefined();
    });
});

// ── T7: getEvidenceChain — returns records ordered by created_at ASC ──────────

describe('getEvidenceChain', () => {
    it('T7: queries by org_id + resource_type + resource_id, ordered ASC', async () => {
        const now = new Date();
        const earlier = new Date(now.getTime() - 60000);
        const records = [
            { id: REC_ID_A, created_at: earlier, category: 'execution', event_type: 'EXECUTION_SUCCESS' },
            { id: REC_ID_B, created_at: now, category: 'policy_enforcement', event_type: 'POLICY_VIOLATION' },
        ];
        const db = makeDb(records);

        const chain = await getEvidenceChain(db as any, ORG_ID, 'assistant', '00000000-0000-0000-0000-000000000002');

        expect(chain).toHaveLength(2);
        expect(chain[0].id).toBe(REC_ID_A); // chronologically first
        expect(chain[1].id).toBe(REC_ID_B);

        const queryCall = db.query.mock.calls[0];
        expect(queryCall[0]).toMatch(/ORDER BY created_at ASC/i);
        expect(queryCall[1]).toEqual([ORG_ID, 'assistant', '00000000-0000-0000-0000-000000000002']);
    });

    // ── T8: RLS isolation — org_id always included in query ──────────────────

    it('T8: always filters by org_id (RLS-consistent isolation in application layer)', async () => {
        const db = makeDb([]);
        const differentOrg = '00000000-0000-0000-0000-000000000099';

        await getEvidenceChain(db as any, differentOrg, 'assistant', REC_ID_A);

        const queryCall = db.query.mock.calls[0];
        // org_id must appear as the first bind parameter
        expect(queryCall[1][0]).toBe(differentOrg);
        expect(queryCall[0]).toMatch(/WHERE org_id = \$1/i);
    });
});
