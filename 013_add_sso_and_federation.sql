-- Migration: 013_add_sso_and_federation.sql
-- Descrição: Fundação de Identidade Corporativa e Just-In-Time Provisioning.

-- 1. Modificar 'organizations' para suportar federação
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sso_tenant_id VARCHAR(255) UNIQUE;

-- 2. Criar a Tabela 'users' corporativa (Diretores, COOs, etc.)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    sso_provider VARCHAR(50) NOT NULL CHECK (sso_provider IN ('entra_id', 'okta', 'local')),
    sso_user_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_sso_user UNIQUE (sso_provider, sso_user_id)
);

-- Ativar RLS em users para garantir multi-tenancy rigoroso entre orgs
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_isolation_policy ON users;
CREATE POLICY users_isolation_policy ON users
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
