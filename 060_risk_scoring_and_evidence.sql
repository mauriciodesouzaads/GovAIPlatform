-- Migration: 060_risk_scoring_and_evidence.sql
-- Objetivo: adiciona colunas de risk scoring determinístico na tabela assistants
--           e cria index para queries por risco.
-- Relacionado a: src/lib/risk-scoring.ts, FASE-A2.

BEGIN;

-- 1. Risk scoring fields on assistants
ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS data_classification varchar(20)
        DEFAULT 'internal'
        CHECK (data_classification IN ('internal', 'confidential', 'restricted')),
    ADD COLUMN IF NOT EXISTS pii_blocker_enabled boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS output_format varchar(20)
        DEFAULT 'free_text'
        CHECK (output_format IN ('free_text', 'structured_json')),
    ADD COLUMN IF NOT EXISTS risk_score integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS risk_breakdown jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS risk_computed_at timestamptz;

-- 2. Index for risk-based queries (compliance dashboard, risk reports)
CREATE INDEX IF NOT EXISTS idx_assistants_risk_score
    ON assistants(org_id, risk_score DESC);

-- 3. Backfill existing assistants with default risk scores derived from risk_level
--    so the column is not null/zero for already-live assistants.
UPDATE assistants
SET
    risk_score = CASE
        WHEN risk_level = 'low'      THEN 5
        WHEN risk_level = 'medium'   THEN 20
        WHEN risk_level = 'high'     THEN 35
        WHEN risk_level = 'critical' THEN 55
        ELSE 10
    END,
    risk_computed_at = now()
WHERE risk_score = 0 OR risk_score IS NULL;

COMMIT;
