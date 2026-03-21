/**
 * GA-008: RAG isolation tests
 *
 * T1: ingestDocument requires orgId parameter (TypeScript signature)
 * T2: searchSimilarChunks with orgId filters correctly (mock)
 * T3: ingestDocument INSERT includes org_id column
 * T4: pool.query not called directly in rag.ts (contextualised client)
 * T5: RLS migration 037 contains documents_isolation policy
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Static source analysis helpers
// ---------------------------------------------------------------------------

const ragSource = readFileSync(join(__dirname, '../lib/rag.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GA-008: RAG tenant isolation', () => {

    it('T1: ingestDocument has orgId as third parameter (source analysis)', () => {
        // The function signature must be: (pool, kbId, orgId, content, metadata?)
        const match = ragSource.match(/export async function ingestDocument\s*\(([^)]+)\)/);
        expect(match).not.toBeNull();
        const params = match![1].split(',').map(p => p.trim());
        // 3rd param (index 2) should contain 'orgId'
        expect(params.length).toBeGreaterThanOrEqual(4);
        expect(params[2]).toContain('orgId');
    });

    it('T2: searchSimilarChunks SQL includes org_id filter (source analysis)', () => {
        // Extract the searchSimilarChunks function body
        const fnStart = ragSource.indexOf('export async function searchSimilarChunks');
        const fnEnd = ragSource.indexOf('\nexport async function searchWithTokenLimit');
        const fnBody = ragSource.substring(fnStart, fnEnd);
        expect(fnBody).toContain('org_id');
        expect(fnBody).toContain('$3'); // orgId is the 3rd SQL param
    });

    it('T3: ingestDocument INSERT includes org_id column (source analysis)', () => {
        const fnStart = ragSource.indexOf('export async function ingestDocument');
        const fnEnd = ragSource.indexOf('\nexport async function searchSimilarChunks');
        const fnBody = ragSource.substring(fnStart, fnEnd);
        expect(fnBody).toContain('INSERT INTO documents');
        expect(fnBody).toContain('org_id');
    });

    it('T4: rag.ts uses client (not pool.query) for DB calls', () => {
        // Static analysis: verify the source does not use pool.query() directly
        const ragSource = readFileSync(
            join(__dirname, '../lib/rag.ts'),
            'utf-8'
        );
        // pool.query() should not appear in ingestDocument or searchSimilarChunks
        // (only client.query() after connecting)
        const poolQueryMatches = ragSource.match(/\bpool\.query\s*\(/g) || [];
        expect(poolQueryMatches.length).toBe(0);
    });

    it('T5: Migration 037 contains documents_isolation RLS policy', () => {
        const migrationPath = join(__dirname, '../../037_documents_add_org_id.sql');
        const migration = readFileSync(migrationPath, 'utf-8');
        expect(migration).toContain('documents_isolation');
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('org_id');
    });
});
