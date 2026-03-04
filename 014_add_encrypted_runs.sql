-- Migration: 014_add_encrypted_runs.sql
-- Descrição: Pilar "Caixa Negra" - Tabela blindada para armazenamento de payload AES-256-GCM.

CREATE TABLE IF NOT EXISTS run_content_encrypted (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID NOT NULL, -- Ligação com o rastro raiz de auditoria (audit_logs_partitioned ou trace_id)
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Metadados de cifragem AES-256-GCM
    iv_bytes TEXT NOT NULL,
    auth_tag_bytes TEXT NOT NULL,
    content_encrypted_bytes TEXT NOT NULL,
    
    -- Facilita rotação de chaves BYOK no futuro
    key_version VARCHAR(50) NOT NULL DEFAULT 'v1',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ativar RLS em run_content_encrypted para isolamento militar por Org
ALTER TABLE run_content_encrypted ENABLE ROW LEVEL SECURITY;

CREATE POLICY encrypted_content_isolation_policy ON run_content_encrypted
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Índices de performance
CREATE INDEX idx_run_content_org_id ON run_content_encrypted(org_id);
CREATE INDEX idx_run_content_run_id ON run_content_encrypted(run_id);
