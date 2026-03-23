-- Migration: 052_shield_finding_workflow.sql
-- Sprint S2 — Shield Finding Workflow & Consultant Value
--
-- INCREMENTAL: usa ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS.
-- NÃO quebra baseline existente (047–051).
--
-- 1. Enriquecer shield_findings com campos de workflow operacional
-- 2. Enriquecer shield_finding_actions: assign_owner + comment + metadata
-- 3. Enriquecer shield_posture_snapshots: unresolved_critical

BEGIN;

-- ── 1. Enriquecer shield_findings ─────────────────────────────────────────────
-- Colunas já existentes: id, org_id, tool_name, tool_name_normalized, tool_id,
--   severity, status, rationale, first_seen_at, last_seen_at, observation_count,
--   unique_users, acknowledged_at, acknowledged_by, resolved_at, resolved_by,
--   dismissed_at, dismissed_by, accepted_risk, accepted_risk_note,
--   accepted_risk_at, accepted_risk_by, risk_score, risk_dimensions, confidence,
--   recommendation, promotion_candidate, owner_candidate_hash,
--   owner_candidate_source, recommended_action, category, evidence_count,
--   source_types, correlation_count, created_at, updated_at.

ALTER TABLE shield_findings
    ADD COLUMN IF NOT EXISTS owner_assigned_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS owner_assigned_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS owner_note         TEXT,
    ADD COLUMN IF NOT EXISTS dismissed_reason   TEXT,
    ADD COLUMN IF NOT EXISTS reopened_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reopened_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS closed_reason      TEXT,
    ADD COLUMN IF NOT EXISTS last_action_at     TIMESTAMPTZ;

-- ── 2. Enriquecer shield_finding_actions ──────────────────────────────────────
-- Adicionar metadata JSONB.
ALTER TABLE shield_finding_actions
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- Ampliar CHECK constraint para incluir assign_owner e comment.
-- Migration 049 criou: acknowledge|promote|accept_risk|dismiss|resolve|reopen
ALTER TABLE shield_finding_actions
    DROP CONSTRAINT IF EXISTS shield_finding_actions_action_type_check;

ALTER TABLE shield_finding_actions
    ADD CONSTRAINT shield_finding_actions_action_type_check
        CHECK (action_type IN
            ('acknowledge','promote','accept_risk','dismiss','resolve','reopen',
             'assign_owner','comment'));

-- ── 3. Enriquecer shield_posture_snapshots ────────────────────────────────────
-- Colunas já existentes: id, org_id, generated_at, posture, summary_score,
--   open_findings, promoted_findings, accepted_risk, top_tools, recommendations.
ALTER TABLE shield_posture_snapshots
    ADD COLUMN IF NOT EXISTS unresolved_critical INTEGER NOT NULL DEFAULT 0;

COMMIT;
