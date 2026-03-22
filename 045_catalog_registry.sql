-- Migration: 045_catalog_registry.sql
-- Objetivo: transformar assistants em registry formal de capacidades

-- 1. Adicionar lifecycle_state formal em assistants
ALTER TABLE assistants
  ADD COLUMN IF NOT EXISTS lifecycle_state varchar(20)
    DEFAULT 'draft'
    CHECK (lifecycle_state IN
      ('draft','under_review','approved','official','suspended','archived')),
  ADD COLUMN IF NOT EXISTS owner_id uuid
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS owner_email varchar(255),
  ADD COLUMN IF NOT EXISTS risk_level varchar(10)
    DEFAULT 'medium'
    CHECK (risk_level IN ('low','medium','high','critical')),
  ADD COLUMN IF NOT EXISTS risk_justification text,
  ADD COLUMN IF NOT EXISTS capability_tags text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspend_reason text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS description text;

-- 2. Índices para queries de catálogo
CREATE INDEX IF NOT EXISTS idx_assistants_lifecycle
  ON assistants(org_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_assistants_risk
  ON assistants(org_id, risk_level);
CREATE INDEX IF NOT EXISTS idx_assistants_owner
  ON assistants(owner_id);

-- 3. Tabela de runtime bindings (qual runtime executa qual assistant)
CREATE TABLE IF NOT EXISTS capability_runtime_bindings (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id    uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  runtime_type    varchar(50) NOT NULL,
  -- Ex: 'litellm', 'mcp', 'webhook', 'direct_api'
  runtime_config  jsonb DEFAULT '{}',
  is_active       boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(assistant_id, runtime_type)
);

CREATE INDEX IF NOT EXISTS idx_runtime_bindings_assistant
  ON capability_runtime_bindings(assistant_id, is_active);

ALTER TABLE capability_runtime_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_runtime_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS runtime_binding_isolation ON capability_runtime_bindings;
CREATE POLICY runtime_binding_isolation ON capability_runtime_bindings
  FOR ALL TO govai_app
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON capability_runtime_bindings TO govai_app;

-- 4. Tabela de review de catálogo (trilha de revisões)
CREATE TABLE IF NOT EXISTS catalog_reviews (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id    uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  reviewer_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_email  varchar(255),
  previous_state  varchar(20),
  new_state       varchar(20),
  decision        varchar(20) NOT NULL
    CHECK (decision IN ('approved','rejected','needs_changes')),
  comments        text,
  created_at      timestamptz DEFAULT now() NOT NULL
);

-- Imutável
CREATE OR REPLACE FUNCTION prevent_catalog_review_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'catalog_reviews é imutável';
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_catalog_review ON catalog_reviews;
CREATE TRIGGER trg_immutable_catalog_review
  BEFORE UPDATE OR DELETE ON catalog_reviews
  FOR EACH ROW EXECUTE FUNCTION prevent_catalog_review_mutation();

ALTER TABLE catalog_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_review_isolation ON catalog_reviews;
CREATE POLICY catalog_review_isolation ON catalog_reviews
  FOR ALL TO govai_app
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT ON catalog_reviews TO govai_app;

-- 5. Sincronizar lifecycle_state com status existente (retrocompatibilidade)
UPDATE assistants
SET lifecycle_state = CASE
  WHEN status = 'published' THEN 'official'
  WHEN status = 'draft'     THEN 'draft'
  ELSE 'draft'
END
WHERE lifecycle_state = 'draft';
