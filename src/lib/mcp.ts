import { z } from 'zod';

// Zod Schema for mcp_servers
export const McpServerSchema = z.object({
    id: z.string().uuid().optional(),
    org_id: z.string().uuid(),
    name: z.string().min(1, "O nome do servidor MCP é obrigatório"),
    base_url: z.string().url("URL Base inválida"),
    status: z.enum(['active', 'inactive']).default('active'),
    created_at: z.date().optional()
});
export type McpServer = z.infer<typeof McpServerSchema>;

// Zod Schema for connector_version_grants
export const ConnectorVersionGrantSchema = z.object({
    id: z.string().uuid().optional(),
    org_id: z.string().uuid(),
    assistant_version_id: z.string().uuid(),
    mcp_server_id: z.string().uuid(),
    allowed_tools_jsonb: z.array(z.string()).min(1, "É obrigatório listar pelo menos uma tool autorizada"),
    created_at: z.date().optional()
});
export type ConnectorVersionGrant = z.infer<typeof ConnectorVersionGrantSchema>;

// Schema for fetching available MCP tools given an assistant version
export const McpToolLookupResponseSchema = z.object({
    mcp_server_id: z.string().uuid(),
    base_url: z.string().url(),
    allowed_tools: z.array(z.string())
});
export type McpToolLookupResponse = z.infer<typeof McpToolLookupResponseSchema>;
