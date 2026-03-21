-- Migration: 044_evidence_domain.sql
-- Objetivo: domínio formal de evidência transversal

-- Tipos de evidência (idempotente: DO block para compatibilidade com PG < 14)
DO $$ BEGIN
  CREATE TYPE evidence_category AS ENUM (
    'execution',
    'policy_enforcement',
    'approval',
    'publication',
    'policy_exception',
    'oidc_session',
    'api_key_lifecycle',
    'data_access'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

-- Tabela central de registros de evidência
CREATE TABLE IF NOT EXISTS evidence_records (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category        evidence_category NOT NULL,
  event_type      varchar(100) NOT NULL,
  -- Ex: 'EXECUTION_SUCCESS', 'POLICY_VIOLATION', 'APPROVAL_GRANTED',
  --     'VERSION_PUBLISHED', 'EXCEPTION_APPROVED', 'API_KEY_REVOKED'
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email     varchar(255),
  resource_type   varchar(100),
  -- Ex: 'assistant', 'assistant_version', 'api_key', 'policy_exception'
  resource_id     uuid,
  metadata        jsonb DEFAULT '{}',
  integrity_hash  varchar(64),  -- SHA-256(org_id||category||event_type||metadata)
  created_at      timestamptz DEFAULT now() NOT NULL
);

-- Tabela de links de evidência (encadeia registros entre si)
CREATE TABLE IF NOT EXISTS evidence_links (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  from_record_id  uuid NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  to_record_id    uuid NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  link_type       varchar(50) NOT NULL,
  -- Ex: 'caused_by', 'approved_by', 'policy_of', 'version_of', 'exception_for'
  created_at      timestamptz DEFAULT now() NOT NULL,
  UNIQUE(from_record_id, to_record_id, link_type)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_evidence_records_org_category
  ON evidence_records(org_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_records_resource
  ON evidence_records(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_evidence_records_actor
  ON evidence_records(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_links_from
  ON evidence_links(from_record_id);
CREATE INDEX IF NOT EXISTS idx_evidence_links_to
  ON evidence_links(to_record_id);

-- Imutabilidade de evidence_records
CREATE OR REPLACE FUNCTION prevent_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence_records é imutável';
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_evidence ON evidence_records;
CREATE TRIGGER trg_immutable_evidence
  BEFORE UPDATE OR DELETE ON evidence_records
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- RLS — evidence_records
ALTER TABLE evidence_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evidence_isolation ON evidence_records;
CREATE POLICY evidence_isolation ON evidence_records
  FOR ALL TO govai_app
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- RLS — evidence_links (herda isolamento via FK para evidence_records)
ALTER TABLE evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evidence_links_isolation ON evidence_links;
CREATE POLICY evidence_links_isolation ON evidence_links
  FOR ALL TO govai_app
  USING (
    from_record_id IN (
      SELECT id FROM evidence_records
      WHERE org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

-- Grants
GRANT SELECT, INSERT ON evidence_records TO govai_app;
GRANT SELECT, INSERT ON evidence_links TO govai_app;

-- Adicionar correlation_id em execution_runs (se tabela existir)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'execution_runs') THEN
    ALTER TABLE execution_runs
      ADD COLUMN IF NOT EXISTS correlation_id uuid DEFAULT uuid_generate_v4(),
      ADD COLUMN IF NOT EXISTS evidence_record_id uuid
        REFERENCES evidence_records(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Adicionar evidence_record_id em assistant_publication_events
ALTER TABLE assistant_publication_events
  ADD COLUMN IF NOT EXISTS evidence_record_id uuid
  REFERENCES evidence_records(id) ON DELETE SET NULL;

-- Adicionar evidence_record_id em pending_approvals
ALTER TABLE pending_approvals
  ADD COLUMN IF NOT EXISTS evidence_record_id uuid
  REFERENCES evidence_records(id) ON DELETE SET NULL;
