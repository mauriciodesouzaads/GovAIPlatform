-- Migration: 012_add_mcp_servers_and_grants.sql
-- Descrição: Implementa a fundação do Model Context Protocol (MCP) para o Data Plane.

-- 1. Criação da Tabela mcp_servers
CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    base_url VARCHAR(2048) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ativar RLS em mcp_servers para garantir multi-tenancy rigoroso
ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY mcp_servers_isolation_policy ON mcp_servers
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE INDEX idx_mcp_servers_org_id ON mcp_servers(org_id);


-- 2. Criação da Tabela connector_version_grants (O "Alvará" imutável)
CREATE TABLE IF NOT EXISTS connector_version_grants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_version_id UUID NOT NULL REFERENCES assistant_versions(id) ON DELETE CASCADE,
    mcp_server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    allowed_tools_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array de strings com os nomes das tools autorizadas
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_grant_per_version UNIQUE (assistant_version_id, mcp_server_id)
);

-- Ativar RLS em connector_version_grants
ALTER TABLE connector_version_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY grants_isolation_policy ON connector_version_grants
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE INDEX idx_grants_assistant_version_id ON connector_version_grants(assistant_version_id);
CREATE INDEX idx_grants_mcp_server_id ON connector_version_grants(mcp_server_id);
