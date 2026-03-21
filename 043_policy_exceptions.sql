-- Migration: 043_policy_exceptions.sql
-- Objetivo: domínio formal de exceções de política com approval e expiração

CREATE TABLE IF NOT EXISTS policy_exceptions (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id    uuid REFERENCES assistants(id) ON DELETE CASCADE,
  exception_type  varchar(100) NOT NULL,
  -- Tipos: 'allow_sensitive_topic', 'bypass_hitl', 'extend_token_limit', etc.
  justification   text NOT NULL,
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoke_reason   text,
  status          varchar(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'expired')),
  created_at      timestamptz DEFAULT now() NOT NULL,
  created_by      uuid REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_policy_exceptions_org
  ON policy_exceptions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_policy_exceptions_assistant
  ON policy_exceptions(assistant_id, status);
CREATE INDEX IF NOT EXISTS idx_policy_exceptions_expiry
  ON policy_exceptions(expires_at) WHERE status = 'approved';

-- RLS
ALTER TABLE policy_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_exceptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_exception_isolation ON policy_exceptions;
CREATE POLICY policy_exception_isolation ON policy_exceptions
  FOR ALL TO govai_app
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- Grants
GRANT SELECT, INSERT, UPDATE ON policy_exceptions TO govai_app;

-- Active exceptions query for hot path: call via SECURITY DEFINER bypasses RLS
-- Verificação no hot path: exceptions ativas para um assistente
CREATE OR REPLACE FUNCTION get_active_exceptions(
  p_org_id uuid,
  p_assistant_id uuid
) RETURNS TABLE(exception_type varchar, expires_at timestamptz) AS $$
  SELECT exception_type, expires_at
  FROM policy_exceptions
  WHERE org_id = p_org_id
    AND (assistant_id = p_assistant_id OR assistant_id IS NULL)
    AND status = 'approved'
    AND expires_at > NOW()
    AND revoked_at IS NULL;
$$ LANGUAGE sql SECURITY DEFINER;
