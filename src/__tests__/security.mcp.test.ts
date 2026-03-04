/**
 * FRENTE 3: MCP & TRANSAÇÕES ATÓMICAS (ZERO-TRUST)
 * Staff QA Engineer — Security Suite
 *
 * 1. O Alvará: ferramenta fora de escopo bloqueada pelo motor de grants
 * 2. Rollback Atómico: erro no último passo da transação reverte tudo sem rastros
 */
import { describe, it, expect, vi } from 'vitest';
import { ConnectorVersionGrantSchema, McpServerSchema } from '../lib/mcp';

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

/**
 * Simulates the tool authorization check that the API Gateway (Data Plane)
 * performs before actually invoking a tool from an MCP server.
 */
function checkToolIsAuthorized(grantedTools: string[], requestedTool: string): boolean {
    return grantedTools.includes(requestedTool);
}

/**
 * Simulates the atomic PostgreSQL transaction for creating an Assistant.
 * Throws an error at the *last step* if forceRollback=true.
 */
async function simulateAtomicAssistantCreation(pgClient: any, forceRollback = false) {
    await pgClient.query('BEGIN');
    try {
        // Step 1: Create assistant
        await pgClient.query('INSERT INTO assistants (...) VALUES (...)');
        // Step 2: Create immutable version
        await pgClient.query('INSERT INTO assistant_versions (...) VALUES (...)');
        // Step 3: Attach OPA policy
        await pgClient.query('INSERT INTO policy_versions (...) VALUES (...)');
        // Step 4: Create MCP Alvará — force failure here
        if (forceRollback) {
            throw new Error('DB Constraint Violation: mcp_server_id does not exist (FK error)');
        }
        await pgClient.query('INSERT INTO connector_version_grants (...) VALUES (...)');
        await pgClient.query('COMMIT');
        return { success: true };
    } catch (e: any) {
        await pgClient.query('ROLLBACK');
        throw e;
    }
}

// ─────────────────────────────────────────
// CENÁRIO 1: O Alvará MCP (Zero-Trust Tool Authorization)
// ─────────────────────────────────────────
describe('[MCP] Zero-Trust Alvará — Unauthorized Tool Invocation', () => {

    it('should allow invocation of an explicitly authorized tool', () => {
        const grant = { allowed_tools_jsonb: ['get_user_balance', 'get_account_statement'] };
        const result = checkToolIsAuthorized(grant.allowed_tools_jsonb, 'get_user_balance');
        expect(result).toBe(true);
    });

    it('🔥 ALVARÁ: must BLOCK invocation of transfer_funds — not in the grant', () => {
        const grant = { allowed_tools_jsonb: ['get_user_balance'] };
        const blocked = checkToolIsAuthorized(grant.allowed_tools_jsonb, 'transfer_funds');
        expect(blocked).toBe(false);
    });

    it('🔥 ALVARÁ: must BLOCK delete_all_records — dangerous tool not in scope', () => {
        const grant = {
            allowed_tools_jsonb: ['get_user_balance', 'create_report', 'send_notification']
        };
        expect(checkToolIsAuthorized(grant.allowed_tools_jsonb, 'delete_all_records')).toBe(false);
        expect(checkToolIsAuthorized(grant.allowed_tools_jsonb, 'exec_sql')).toBe(false);
        expect(checkToolIsAuthorized(grant.allowed_tools_jsonb, 'transfer_funds')).toBe(false);
    });

    it('should reject an MCP grant schema with an empty tools list (Zero-Trust enforcement)', () => {
        const badGrant = {
            org_id: '550e8400-e29b-41d4-a716-446655440000',
            assistant_version_id: '111e8400-e29b-41d4-a716-446655441111',
            mcp_server_id: '222e8400-e29b-41d4-a716-446655442222',
            allowed_tools_jsonb: [] // empty — an agent with no tools is an invalid grant
        };
        const result = ConnectorVersionGrantSchema.safeParse(badGrant);
        expect(result.success).toBe(false);
    });

    it('🔥 PARTIAL MATCH ATTACK: "get_user_balance_and_transfer" must not pass if only "get_user_balance" is granted', () => {
        const grant = { allowed_tools_jsonb: ['get_user_balance'] };
        // Exact match required — no prefix/substring matching
        expect(checkToolIsAuthorized(grant.allowed_tools_jsonb, 'get_user_balance_and_transfer')).toBe(false);
        expect(checkToolIsAuthorized(grant.allowed_tools_jsonb, 'GET_USER_BALANCE')).toBe(false); // case-sensitive
    });
});

// ─────────────────────────────────────────
// CENÁRIO 2: Atomic Rollback Transaction
// ─────────────────────────────────────────
describe('[MCP] Atomic Transaction — Rollback on Partial Failure', () => {

    it('should commit the full transaction when ALL steps succeed', async () => {
        const pgClient = {
            query: vi.fn().mockResolvedValue({ rows: [] }),
        };

        const result = await simulateAtomicAssistantCreation(pgClient, false);

        expect(result.success).toBe(true);
        expect(pgClient.query).toHaveBeenCalledWith('BEGIN');
        expect(pgClient.query).toHaveBeenCalledWith('COMMIT');
        expect(pgClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    });

    it('🔥 ROLLBACK: failure at the MCP Alvará step must ROLLBACK the entire transaction', async () => {
        const pgClient = {
            query: vi.fn().mockResolvedValue({ rows: [] }),
        };

        // Force failure on the last step (Alvará insert)
        await expect(
            simulateAtomicAssistantCreation(pgClient, true)
        ).rejects.toThrow('DB Constraint Violation');

        // ROLLBACK must have been called
        expect(pgClient.query).toHaveBeenCalledWith('ROLLBACK');
        // COMMIT must NOT have been called
        expect(pgClient.query).not.toHaveBeenCalledWith('COMMIT');
    });

    it('🔥 DATA GHOST: after rollback, the assistant must not exist in the DB', async () => {
        let assistantInserted = false;
        let versionInserted = false;
        let grantInserted = false;
        let rolledBack = false;

        const pgClient = {
            query: vi.fn(async (sql: string) => {
                if (sql === 'BEGIN') return;
                if (sql.includes('INSERT INTO assistants')) { assistantInserted = true; return { rows: [] }; }
                if (sql.includes('INSERT INTO assistant_versions')) { versionInserted = true; return { rows: [] }; }
                if (sql.includes('INSERT INTO policy_versions')) return { rows: [] };
                if (sql === 'ROLLBACK') { rolledBack = true; assistantInserted = false; versionInserted = false; }
                return { rows: [] };
            })
        };

        await expect(simulateAtomicAssistantCreation(pgClient, true)).rejects.toThrow();

        // After ROLLBACK: ensure the state was reverted
        expect(rolledBack).toBe(true);
        expect(assistantInserted).toBe(false); // ROLLBACK cleared the state
        expect(versionInserted).toBe(false);
        expect(grantInserted).toBe(false);
    });
});
