-- Migration: 011_add_assistant_and_policy_versions.sql
-- Descrição: Implementa versionamento imutável de Assistentes e Políticas para o Control Plane.

-- 1. Criação da Tabela policy_versions
CREATE TABLE IF NOT EXISTS policy_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    rules_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb, -- Armazena { "forbidden_topics": [...], "pii_filter": true, "strict_mode": true }
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ativar RLS em policy_versions
ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_versions_isolation_policy ON policy_versions;
CREATE POLICY policy_versions_isolation_policy ON policy_versions
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Criar índice para busca rápida por versão
CREATE INDEX IF NOT EXISTS idx_policy_versions_org_id ON policy_versions(org_id);


-- 2. Criação da Tabela assistant_versions
CREATE TABLE IF NOT EXISTS assistant_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    policy_version_id UUID NOT NULL REFERENCES policy_versions(id), -- Amarração estrita com a política governante
    prompt TEXT NOT NULL,
    tools_jsonb JSONB DEFAULT '[]'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(50) DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ativar RLS em assistant_versions
ALTER TABLE assistant_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_versions_isolation_policy ON assistant_versions;
CREATE POLICY assistant_versions_isolation_policy ON assistant_versions
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Criar índice
CREATE INDEX IF NOT EXISTS idx_assistant_versions_assistant_id ON assistant_versions(assistant_version_id);


-- 3. Trigger de Imutabilidade para assistant_versions (Garantia Jurídica)
-- Uma versão publicada nunca pode ser alterada ou apagada, apenas 'archived' via insert de nova versão (na prática, apenas bloqueia UPDATE/DELETE na versão atual).
CREATE OR REPLACE FUNCTION prevent_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Immutable Version Error: Não é permitido alterar (UPDATE) ou apagar (DELETE) uma versão de assistente gravada no Cartório. Crie uma nova versão.';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS make_assistant_versions_immutable ON assistant_versions;
CREATE TRIGGER make_assistant_versions_immutable
BEFORE UPDATE OR DELETE ON assistant_versions
FOR EACH ROW
EXECUTE FUNCTION prevent_version_mutation();

-- FIM DA MIGRATION
