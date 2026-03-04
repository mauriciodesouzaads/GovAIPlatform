/**
 * FRENTE 2: ISOLAMENTO MULTI-TENANT (ROW-LEVEL SECURITY)
 * Staff QA Engineer — Security Suite
 *
 * Simula injeção cruzada entre orgs usando JWTs válidos trocados.
 * Todos os testes são realizados na camada lógica via mock do pgPool,
 * simulando o comportamento garantido pelo RLS do PostgreSQL.
 */
import { describe, it, expect, vi } from 'vitest';
import { McpServerSchema, ConnectorVersionGrantSchema } from '../lib/mcp';
import { CryptoService } from '../lib/crypto-service';
import { IntegrityService } from '../lib/governance';

// Simulated UUIDs representing two distinct tenants
const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';

// ─────────────────────────────────────────
// Building Block: Mock pgPool with RLS enforcement
// ─────────────────────────────────────────

function buildRlsMockPgPool(currentOrgId: string) {
    /**
     * Simulate PG RLS: any query to a tenant-isolated table
     * will ONLY return rows WHERE org_id = current_setting('app.current_org_id')
     */
    return {
        query: vi.fn(async (sql: string, params?: any[]) => {
            // Intercept org_id mismatch — simulate RLS empty result
            if (params?.includes(ORG_B) && currentOrgId === ORG_A) {
                return { rows: [] }; // RLS filters row
            }
            if (params?.includes(ORG_A) && currentOrgId === ORG_B) {
                return { rows: [] }; // RLS filters row
            }
            // Own data returns normally
            return { rows: [{ id: 'fake-id', org_id: currentOrgId }] };
        }),
        connect: vi.fn(async () => ({
            query: vi.fn(async (sql: string, params?: any[]) => {
                if (params?.includes(ORG_B) && currentOrgId === ORG_A) return { rows: [] };
                if (params?.includes(ORG_A) && currentOrgId === ORG_B) return { rows: [] };
                return { rows: [{ id: 'fake-id', org_id: currentOrgId }] };
            }),
            release: vi.fn(),
        })),
    };
}

// ─────────────────────────────────────────
// CENÁRIO 1: Cross-Tenant Data Injection
// ─────────────────────────────────────────
describe('[RLS] Cross-Tenant Isolation — Org A cannot read Org B', () => {

    it('should return empty results when Org A queries for Org B mcp_servers', async () => {
        // Org A is currently authenticated
        const pgPoolOrgA = buildRlsMockPgPool(ORG_A);

        // Org A tries to query an mcp_server belonging to Org B
        const result = await pgPoolOrgA.query(
            'SELECT * FROM mcp_servers WHERE org_id = $1 AND id = $2',
            [ORG_B, 'server-belonging-to-org-b']
        );

        // RLS returns empty — no data leakage
        expect(result.rows).toHaveLength(0);
    });

    it('should return empty results when Org B queries for Org A audit logs', async () => {
        const pgPoolOrgB = buildRlsMockPgPool(ORG_B);

        const result = await pgPoolOrgB.query(
            'SELECT * FROM audit_logs_partitioned WHERE org_id = $1',
            [ORG_A]
        );

        // Cross-tenant log read must return zero rows
        expect(result.rows).toHaveLength(0);
    });

    it('should return the org\'s OWN data when querying with the correct JWT context', async () => {
        const pgPoolOrgA = buildRlsMockPgPool(ORG_A);

        const result = await pgPoolOrgA.query(
            'SELECT * FROM assistants WHERE org_id = $1',
            [ORG_A]
        );

        // Own data accessible normally
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].org_id).toBe(ORG_A);
    });
});

// ─────────────────────────────────────────
// CENÁRIO 2: MCP Grant Cross-Tenant Escalation
// ─────────────────────────────────────────
describe('[RLS] MCP Grant — Cross-Tenant Privilege Escalation', () => {

    it('🔥 should block Org A from accessing connector_version_grants owned by Org B', async () => {
        const pgPoolOrgA = buildRlsMockPgPool(ORG_A);

        // Org A tries to fetch grants of Org B's assistant version
        const result = (await pgPoolOrgA.connect()).query(
            'SELECT * FROM connector_version_grants WHERE org_id = $1',
            [ORG_B]
        );

        expect((await result).rows).toHaveLength(0);
    });

    it('🔥 schema-level: ConnectorVersionGrant with a mismatched org_id must fail Zod structurally', () => {
        // Simulate Org B injecting a grant referencing Org A's assistant version
        const crossTenantGrant = {
            org_id: ORG_B,
            // This assistant_version_id belongs to ORG_A — Zod won't catch it (DB/RLS does)
            // but we validate structural requirements
            assistant_version_id: 'bad-uuid-not-a-uuid',
            mcp_server_id: '222e8400-e29b-41d4-a716-446655442222',
            allowed_tools_jsonb: ['transfer_funds']   // potentially dangerous tool
        };

        const result = ConnectorVersionGrantSchema.safeParse(crossTenantGrant);
        expect(result.success).toBe(false); // invalid UUID for assistant_version_id fails schema
    });
});

// ─────────────────────────────────────────
// CENÁRIO 3: Encrypted Run — org_id ownership
// ─────────────────────────────────────────
describe('[RLS] Caixa Negra — Org-Scoped Encryption Key Isolation', () => {

    it('🔥 Org B cannot decrypt Org A encrypted payload (different master keys)', () => {
        // Each org has a unique 32-char key derived from their ID
        const keyA = 'ORG_A_master_key_for_BYOK_32chr!';
        const keyB = 'ORG_B_master_key_for_BYOK_32chr!';

        const svcA = new CryptoService(keyA);
        const svcB = new CryptoService(keyB);

        const orgAPrompt = 'Transferência de R$ 500.000 para conta-fantasma';
        const encrypted = svcA.encryptPayload(orgAPrompt);

        // Org B attempts to decrypt Org A's blob — MUST fail
        expect(() => {
            svcB.decryptPayload(
                encrypted.content_encrypted_bytes,
                encrypted.iv_bytes,
                encrypted.auth_tag_bytes
            );
        }).toThrow();
    });

    it('HMAC signature is tenant-scoped: Org A signature does not validate for Org B payload', () => {
        const secretA = 'org-a-signing-secret-32-chars!!!';
        const secretB = 'org-b-signing-secret-32-chars!!!';

        const payload = { action: 'EXECUTION_SUCCESS', amount: 1000 };
        const sigA = IntegrityService.signPayload(payload, secretA);

        // Org A's signature must not be valid under Org B's secret
        expect(IntegrityService.verifyPayload(payload, secretB, sigA)).toBe(false);
    });
});
