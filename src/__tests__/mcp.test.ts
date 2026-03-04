import { describe, it, expect } from 'vitest';
import { McpServerSchema, ConnectorVersionGrantSchema } from '../lib/mcp';

describe('Model Context Protocol (MCP) Foundation', () => {

    describe('McpServerSchema Validation', () => {
        it('should validate a correct MCP Server object', () => {
            const validData = {
                org_id: '550e8400-e29b-41d4-a716-446655440000',
                name: 'Jira Enterprise Connector',
                base_url: 'https://jira.govai.internal/mcp',
                status: 'active' as const
            };
            const result = McpServerSchema.safeParse(validData);
            expect(result.success).toBe(true);
        });

        it('should reject an invalid base_url', () => {
            const invalidData = {
                org_id: '550e8400-e29b-41d4-a716-446655440000',
                name: 'Broken Server',
                base_url: 'not-a-url',
                status: 'active' as const
            };
            const result = McpServerSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0].message).toBe("URL Base inválida");
            }
        });
    });

    describe('ConnectorVersionGrantSchema (The Alvará)', () => {
        it('should validate a correct Grant linking version to MCP Server', () => {
            const validData = {
                org_id: '550e8400-e29b-41d4-a716-446655440000',
                assistant_version_id: '111e8400-e29b-41d4-a716-446655441111',
                mcp_server_id: '222e8400-e29b-41d4-a716-446655442222',
                allowed_tools_jsonb: ['jira_create_issue', 'jira_get_ticket']
            };
            const result = ConnectorVersionGrantSchema.safeParse(validData);
            expect(result.success).toBe(true);
        });

        it('should reject a Grant if the allowed tools list is empty (Zero-Trust enforcement)', () => {
            const invalidData = {
                org_id: '550e8400-e29b-41d4-a716-446655440000',
                assistant_version_id: '111e8400-e29b-41d4-a716-446655441111',
                mcp_server_id: '222e8400-e29b-41d4-a716-446655442222',
                allowed_tools_jsonb: [] // Empty
            };
            const result = ConnectorVersionGrantSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0].message).toBe("É obrigatório listar pelo menos uma tool autorizada");
            }
        });
    });
});
