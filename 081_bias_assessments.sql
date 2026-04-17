-- Migration: 081_bias_assessments.sql
-- FASE 13.1 — Model Bias Detection
-- ---------------------------------------------------------------------------
-- Each assistant_version MAY carry one or more bias_assessments. A verdict
-- of 'fail' on a required-gate version blocks publication. Fairness metrics
-- are deterministic — the API stores per-group breakdowns plus derived
-- metrics (demographic_parity, equalized_odds, disparate_impact,
-- statistical_parity) so auditors can recompute and verify from first
-- principles. Evidence records are linked via evidence_record_id for the
-- HMAC-signed audit chain.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── evidence_category: add 'bias_assessment' value (idempotent) ────────────
-- ALTER TYPE .. ADD VALUE cannot run inside a DO block with exception
-- handling, so we guard it with pg_enum lookup.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'evidence_category'
          AND e.enumlabel = 'bias_assessment'
    ) THEN
        ALTER TYPE evidence_category ADD VALUE 'bias_assessment';
    END IF;
END $$;

-- ── bias_assessments table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bias_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_version_id UUID NOT NULL REFERENCES assistant_versions(id) ON DELETE CASCADE,

    -- Methodology
    test_dataset_name TEXT NOT NULL,
    test_dataset_size INTEGER NOT NULL CHECK (test_dataset_size > 0),
    protected_attributes JSONB NOT NULL, -- ex: ["gender", "race", "age_group"]

    -- Metrics (all optional — some tests only measure one aspect)
    demographic_parity NUMERIC(6,4),     -- |P(y=1|A=0) - P(y=1|A=1)| ideal near 0
    equalized_odds NUMERIC(6,4),         -- max TPR/FPR difference between groups
    disparate_impact NUMERIC(6,4),       -- ratio P(y=1|A=0) / P(y=1|A=1) ideal near 1
    statistical_parity NUMERIC(6,4),

    -- Thresholds applied + verdict
    thresholds JSONB NOT NULL DEFAULT '{
        "demographic_parity_max": 0.1,
        "equalized_odds_max": 0.1,
        "disparate_impact_min": 0.8,
        "disparate_impact_max": 1.25
    }'::jsonb,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'warn', 'fail')),

    -- Raw results + per-group breakdowns
    group_breakdowns JSONB NOT NULL, -- { "gender=F": {n: 500, tpr: 0.82, fpr: 0.05}, ... }
    raw_results JSONB,

    -- Context
    methodology_notes TEXT,
    performed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Evidence link (for audit trail)
    evidence_record_id UUID REFERENCES evidence_records(id) ON DELETE SET NULL,

    UNIQUE(assistant_version_id, test_dataset_name)
);

CREATE INDEX IF NOT EXISTS idx_bias_assessments_org_verdict
    ON bias_assessments(org_id, verdict);
CREATE INDEX IF NOT EXISTS idx_bias_assessments_version
    ON bias_assessments(assistant_version_id);
CREATE INDEX IF NOT EXISTS idx_bias_assessments_performed_at
    ON bias_assessments(org_id, performed_at DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE bias_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bias_assessments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_bias ON bias_assessments;
CREATE POLICY org_isolation_bias ON bias_assessments
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bias_assessments TO govai_app;

-- NOTE: assistant_versions is enforced as IMMUTABLE by the Cartório trigger
-- `prevent_version_mutation` — any UPDATE raises. We therefore do NOT mirror
-- the latest bias verdict onto assistant_versions. Instead, list queries
-- derive it on demand via:
--
--   SELECT av.*, (
--       SELECT ba.verdict FROM bias_assessments ba
--        WHERE ba.assistant_version_id = av.id AND ba.org_id = av.org_id
--     ORDER BY ba.performed_at DESC LIMIT 1
--   ) AS latest_bias_verdict
--     FROM assistant_versions av
--    WHERE av.org_id = $1;
--
-- This preserves the Cartório invariant (versions never mutate) while still
-- giving the UI a single-shot query for the dashboard view.

COMMIT;
