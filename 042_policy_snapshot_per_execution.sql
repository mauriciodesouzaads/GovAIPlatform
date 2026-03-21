-- Migration: 042_policy_snapshot_per_execution.sql
-- Objetivo: registrar snapshot imutável da política efetiva por execução

-- Tabela de snapshots de política
CREATE TABLE IF NOT EXISTS policy_snapshots (
  id            uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id  uuid REFERENCES assistants(id) ON DELETE SET NULL,
  version_id    uuid REFERENCES assistant_versions(id) ON DELETE SET NULL,
  policy_hash   varchar(64) NOT NULL,  -- SHA-256 do conteúdo da política
  policy_json   jsonb NOT NULL,        -- snapshot imutável do conteúdo
  opa_bundle_hash varchar(64),         -- hash do bundle OPA em uso
  captured_at   timestamptz DEFAULT now() NOT NULL,
  captured_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Índices para queries frequentes
CREATE INDEX IF NOT EXISTS idx_policy_snapshots_org_id
  ON policy_snapshots(org_id);
CREATE INDEX IF NOT EXISTS idx_policy_snapshots_assistant_id
  ON policy_snapshots(assistant_id);
CREATE INDEX IF NOT EXISTS idx_policy_snapshots_hash
  ON policy_snapshots(policy_hash);

-- Tornar imutável (como assistant_publication_events)
CREATE OR REPLACE FUNCTION prevent_policy_snapshot_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'policy_snapshots é imutável — registros não podem ser alterados';
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_policy_snapshot ON policy_snapshots;
CREATE TRIGGER trg_immutable_policy_snapshot
  BEFORE UPDATE OR DELETE ON policy_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_policy_snapshot_mutation();

-- Adicionar coluna policy_snapshot_id em execution_runs (se tabela existir)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'execution_runs') THEN
    ALTER TABLE execution_runs
      ADD COLUMN IF NOT EXISTS policy_snapshot_id uuid
      REFERENCES policy_snapshots(id) ON DELETE SET NULL;
  END IF;
END$$;

-- RLS
ALTER TABLE policy_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_snapshot_isolation ON policy_snapshots;
CREATE POLICY policy_snapshot_isolation ON policy_snapshots
  FOR ALL TO govai_app
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- Grants
GRANT SELECT, INSERT ON policy_snapshots TO govai_app;
