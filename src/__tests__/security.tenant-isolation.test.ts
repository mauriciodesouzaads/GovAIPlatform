import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

describe('Multi-Tenant RLS Isolation Audit', () => {
    let pool: Pool;
    const orgAId = uuidv4();
    const orgBId = uuidv4();
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        throw new Error('DATABASE_URL environment variable is required for tenant isolation tests.');
    }
    beforeAll(async () => {
        pool = new Pool({ connectionString: dbUrl });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // 1. Create Organizations
            await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
                orgAId, `Audit Org A ${orgAId.substring(0, 5)}`,
                orgBId, `Audit Org B ${orgBId.substring(0, 5)}`
            ]);

            // 2. Seed data for Org B (The Victim)
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgBId]);

            // Assistant
            const assistId = uuidv4();
            await client.query("INSERT INTO assistants (id, org_id, name, status) VALUES ($1, $2, 'Secret Assistant B', 'published')", [
                assistId, orgBId
            ]);

            // Audit Log
            await client.query("INSERT INTO audit_logs_partitioned (org_id, assistant_id, action, signature) VALUES ($1, $2, 'POLICY_VIOLATION', 'sig-b')", [
                orgBId, assistId
            ]);

            // Pending Approval
            await client.query("INSERT INTO pending_approvals (org_id, assistant_id, message, policy_reason, status) VALUES ($1, $2, $3, $4, 'pending')", [
                orgBId, assistId, 'Transfer request', 'High value'
            ]);

            // Knowledge Base
            await client.query("INSERT INTO knowledge_bases (org_id, name) VALUES ($1, 'B Secret Data')", [
                orgBId
            ]);

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    afterAll(async () => {
        const client = await pool.connect();
        try {
            for (const org of [orgAId, orgBId]) {
                await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [org]);
                await client.query('DELETE FROM pending_approvals WHERE org_id = $1', [org]);
                await client.query('DELETE FROM audit_logs_partitioned WHERE org_id = $1', [org]);
                await client.query('DELETE FROM knowledge_bases WHERE org_id = $1', [org]);
                // Need to clear policy versions and assistant versions too if they were created implicitly
                await client.query('DELETE FROM assistant_versions WHERE org_id = $1', [org]);
                await client.query('DELETE FROM policy_versions WHERE org_id = $1', [org]);
                await client.query('DELETE FROM assistants WHERE org_id = $1', [org]);
            }

            await client.query(`SELECT set_config('app.current_org_id', '', false)`);
            await client.query('DELETE FROM organizations WHERE id IN ($1, $2)', [orgAId, orgBId]);
        } catch (e) { /* ignore teardown errors */ } finally {
            client.release();
            await pool.end();
        }
    });

    it('Assistants Isolation: Org A should NOT see Org B data', async () => {
        const client = await pool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgAId]);
            const res = await client.query('SELECT * FROM assistants');
            expect(res.rows.some(r => r.org_id === orgBId)).toBe(false);
        } finally {
            client.release();
        }
    });

    it('Audit Logs Isolation: Org A should NOT see Org B logs', async () => {
        const client = await pool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgAId]);
            const res = await client.query('SELECT * FROM audit_logs_partitioned');
            expect(res.rows.some(r => r.org_id === orgBId)).toBe(false);
        } finally {
            client.release();
        }
    });

    it('Pending Approvals Isolation: Org A should NOT see Org B approvals', async () => {
        const client = await pool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgAId]);
            const res = await client.query('SELECT * FROM pending_approvals');
            expect(res.rows.some(r => r.org_id === orgBId)).toBe(false);
        } finally {
            client.release();
        }
    });

    it('Knowledge Base Isolation: Org A should NOT see Org B KB', async () => {
        const client = await pool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgAId]);
            const res = await client.query('SELECT * FROM knowledge_bases');
            expect(res.rows.some(r => r.org_id === orgBId)).toBe(false);
        } finally {
            client.release();
        }
    });

    it('Cross-Tenant Writing: Org A should be BLOCKED from inserting for Org B', async () => {
        const client = await pool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgAId]);
            await expect(client.query(
                "INSERT INTO assistants (id, org_id, name) VALUES ($1, $2, 'Malicious')",
                [uuidv4(), orgBId]
            )).rejects.toThrow();
        } finally {
            client.release();
        }
    });

    it('Tenant Export: Org A export should NOT contain Org B tables', async () => {
        const { exportTenantData } = await import('../lib/offboarding');
        const exportDataA = await exportTenantData(pool, orgAId);

        // Assert none of Org B's data leaked into Org A's export
        for (const { table, data } of exportDataA) {
            expect(data.some((row: any) => row.org_id === orgBId)).toBe(false);
            if (table === 'assistants') {
                expect(data.some((row: any) => row.name === 'Secret Assistant B')).toBe(false);
            }
            if (table === 'knowledge_bases') {
                expect(data.some((row: any) => row.name === 'B Secret Data')).toBe(false);
            }
        }
    });
});
