-- Migration: 046_consultant_plane.sql
-- Objetivo: Consultant Plane — atribuições cross-tenant, audit log imutável, alertas

BEGIN;

-- 1. Tabela de atribuições consultor ↔ tenant
CREATE TABLE IF NOT EXISTS consultant_assignments (
  id                uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  consultant_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  consultant_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_in_tenant    varchar(20) DEFAULT 'observer'
    CHECK (role_in_tenant IN ('observer','advisor','operator','lead')),
  assigned_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at       timestamptz DEFAULT now() NOT NULL,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  revoke_reason     text,
  is_active         boolean DEFAULT true,
  notes             text,
  UNIQUE(consultant_id, tenant_org_id)
);

CREATE INDEX IF NOT EXISTS idx_ca_consultant
  ON consultant_assignments(consultant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ca_tenant
  ON consultant_assignments(tenant_org_id, is_active);

-- 2. Audit log imutável do consultor
CREATE TABLE IF NOT EXISTS consultant_audit_log (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  consultant_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action          varchar(100) NOT NULL,
  resource_type   varchar(100),
  resource_id     uuid,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cal_consultant
  ON consultant_audit_log(consultant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cal_tenant
  ON consultant_audit_log(tenant_org_id, created_at DESC);

-- Imutabilidade: BEFORE UPDATE OR DELETE lança exceção
CREATE OR REPLACE FUNCTION prevent_consultant_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consultant_audit_log é imutável';
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_cal ON consultant_audit_log;
CREATE TRIGGER trg_immutable_cal
  BEFORE UPDATE OR DELETE ON consultant_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_consultant_audit_mutation();

-- 3. Alertas cross-tenant para consultores
CREATE TABLE IF NOT EXISTS consultant_alerts (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  consultant_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alert_type      varchar(100) NOT NULL,
  severity        varchar(10) DEFAULT 'medium'
    CHECK (severity IN ('low','medium','high','critical')),
  title           varchar(255) NOT NULL,
  description     text,
  resource_type   varchar(100),
  resource_id     uuid,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz DEFAULT now() NOT NULL,
  expires_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ca_alerts_consultant
  ON consultant_alerts(consultant_id, acknowledged_at, severity);

COMMIT;
