-- govai-platform/init.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Organizações (Tenants)
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    api_key_hash TEXT -- Para autenticação de aplicações externas
);

-- 2. Assistentes com Versionamento Múltiplo
CREATE TABLE assistants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    current_version_id UUID,
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Audit Log Imutável com Particionamento Declarativo
CREATE TABLE audit_logs_partitioned (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    assistant_id UUID REFERENCES assistants(id),
    action TEXT NOT NULL CHECK (action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'POLICY_VIOLATION', 'ASSISTANT_MODIFICATION')),
    metadata JSONB,
    signature TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id, org_id) -- Necessário para particionamento
) PARTITION BY LIST (org_id);

-- Automação: Criar partição automaticamente para novos clientes
CREATE OR REPLACE FUNCTION create_org_partition()
RETURNS TRIGGER AS $$
BEGIN
    EXECUTE format('CREATE TABLE IF NOT EXISTS audit_logs_org_%s PARTITION OF audit_logs_partitioned FOR VALUES IN (%L)', 
        replace(NEW.id::text, '-', '_'), NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_on_new_org_create_partition
AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION create_org_partition();

-- 4. Segurança de Nível de Linha (RLS)
ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs_partitioned ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON assistants 
    FOR ALL USING (org_id = current_setting('app.current_org_id')::UUID);

CREATE POLICY org_audit_isolation ON audit_logs_partitioned 
    FOR SELECT USING (org_id = current_setting('app.current_org_id')::UUID);

-- 5. Trigger de Imutabilidade Estrita
CREATE OR REPLACE FUNCTION protect_audit_logs() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Erro de Compliance: Logs de auditoria são Append-Only e não podem ser alterados (UPDATE) ou apagados (DELETE).';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_immutable_audit BEFORE UPDATE OR DELETE ON audit_logs_partitioned 
FOR EACH ROW EXECUTE FUNCTION protect_audit_logs();

-- 6. Trigger para Atualizar `updated_at` Automaticamente
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trg_assistants_updated_at BEFORE UPDATE ON assistants 
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- Setup Inicial de Teste (Mock Data)
INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Banco Fictício SA');
INSERT INTO assistants (id, org_id, name, status) VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'Análise de Risco V1', 'published');
