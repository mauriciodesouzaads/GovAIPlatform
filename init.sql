-- govai-platform/init.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Organizações (Tenants)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    api_key_hash TEXT -- Para autenticação de aplicações externas
);

-- 2. Chaves de API (Auth)
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL, -- ex: sk-govai-abcd
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- 3. Assistentes com Versionamento Múltiplo
CREATE TABLE IF NOT EXISTS assistants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    current_version_id UUID,
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. RAG Knowledge Bases
CREATE TABLE IF NOT EXISTS knowledge_bases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    assistant_id UUID REFERENCES assistants(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kb_id UUID NOT NULL REFERENCES knowledge_bases(id),
    content TEXT NOT NULL,
    metadata JSONB,
    embedding vector(768), -- Gemini embedding with output_dimensionality=768 (pgvector max for HNSW: 2000)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance: HNSW index for fast cosine similarity search (RAG)
CREATE INDEX IF NOT EXISTS idx_documents_embedding_hnsw ON documents 
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Performance: B-tree index for filtering by knowledge base
CREATE INDEX IF NOT EXISTS idx_documents_kb_id ON documents (kb_id);

-- 3. Audit Log Imutável com Particionamento Declarativo
CREATE TABLE IF NOT EXISTS audit_logs_partitioned (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    assistant_id UUID REFERENCES assistants(id),
    action TEXT NOT NULL CHECK (action IN ('EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'POLICY_VIOLATION', 'ASSISTANT_MODIFICATION', 'PENDING_APPROVAL', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED')),
    metadata JSONB,
    signature TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id, org_id) -- Necessário para particionamento
) PARTITION BY LIST (org_id);

-- 7. Human-in-the-Loop: Pending Approvals
CREATE TABLE IF NOT EXISTS pending_approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    assistant_id UUID NOT NULL REFERENCES assistants(id),
    message TEXT NOT NULL,
    policy_reason TEXT NOT NULL,
    trace_id TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    reviewer_email TEXT,
    review_note TEXT,
    reviewed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '48 hours'),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance: Index for querying pending approvals efficiently
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals (status, expires_at);

-- 8. Per-tenant HITL Keywords (configurable risk dictionary)
CREATE TABLE IF NOT EXISTS org_hitl_keywords (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    keyword TEXT NOT NULL,
    category TEXT DEFAULT 'high_risk',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, keyword)
);

ALTER TABLE org_hitl_keywords ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_hitl_keywords_isolation ON org_hitl_keywords;
CREATE POLICY org_hitl_keywords_isolation ON org_hitl_keywords
    USING (org_id = current_setting('app.current_org_id', true)::uuid);

-- Automação: Criar partição automaticamente para novos clientes
CREATE OR REPLACE FUNCTION create_org_partition()
RETURNS TRIGGER AS $$
BEGIN
    EXECUTE format('CREATE TABLE IF NOT EXISTS audit_logs_org_%s PARTITION OF audit_logs_partitioned FOR VALUES IN (%L)', 
        replace(NEW.id::text, '-', '_'), NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_on_new_org_create_partition ON organizations;
CREATE TRIGGER trg_on_new_org_create_partition
AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION create_org_partition();

-- 5. Segurança de Nível de Linha (RLS)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs_partitioned ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_api_keys ON api_keys;
CREATE POLICY org_isolation_api_keys ON api_keys 
    FOR ALL USING (org_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS org_isolation ON assistants;
CREATE POLICY org_isolation ON assistants 
    FOR ALL USING (org_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS org_isolation_knowledge ON knowledge_bases;
CREATE POLICY org_isolation_knowledge ON knowledge_bases 
    FOR ALL USING (org_id = current_setting('app.current_org_id', true)::UUID);

DROP POLICY IF EXISTS org_audit_isolation ON audit_logs_partitioned;
CREATE POLICY org_audit_isolation ON audit_logs_partitioned 
    FOR SELECT USING (org_id = current_setting('app.current_org_id', true)::UUID);

ALTER TABLE pending_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_approvals ON pending_approvals;
CREATE POLICY org_isolation_approvals ON pending_approvals 
    FOR ALL USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- 5. Trigger de Imutabilidade Estrita
CREATE OR REPLACE FUNCTION protect_audit_logs() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Erro de Compliance: Logs de auditoria são Append-Only e não podem ser alterados (UPDATE) ou apagados (DELETE).';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_audit ON audit_logs_partitioned;
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

DROP TRIGGER IF EXISTS trg_assistants_updated_at ON assistants;
CREATE TRIGGER trg_assistants_updated_at BEFORE UPDATE ON assistants 
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- 8. Setup Inicial de Teste (Mock Data)
-- Movido para scripts/demo-seed.sh exclusivamente (MEL-02: Isolamento de Produção)

-- MEL-05: Criar política RLS específica para o expiration worker
DROP POLICY IF EXISTS expiration_worker_policy ON pending_approvals;
CREATE POLICY expiration_worker_policy ON pending_approvals
    FOR UPDATE
    USING (status = 'pending' AND expires_at <= NOW())
    WITH CHECK (status = 'expired');

-- [BUG-03] Policy Immutability
-- REMOVED: Managed by migration 011

