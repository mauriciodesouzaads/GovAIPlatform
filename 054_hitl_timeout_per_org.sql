-- Migration: 054_hitl_timeout_per_org.sql
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS hitl_timeout_hours INTEGER
    NOT NULL DEFAULT 4
    CHECK (hitl_timeout_hours BETWEEN 1 AND 168);
-- Default: 4 hours. Range: 1h (minimum) to 168h (7 days maximum).
-- 48h is no longer the hardcoded value anywhere in the codebase.

COMMENT ON COLUMN organizations.hitl_timeout_hours IS
  'Configurable HITL approval window in hours. Default 4h. Range 1–168.';
