-- ============================================================================
-- Migration 015: FinOps — Billing Quotas & Token Metering
-- ============================================================================
-- Allows CROs to set Hard Caps and Soft Caps on token consumption
-- per organization, per assistant, or per department.
-- ============================================================================

-- 1. Quota Configuration Table
CREATE TABLE IF NOT EXISTS billing_quotas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    scope TEXT NOT NULL DEFAULT 'organization',    -- 'organization', 'assistant', 'department'
    scope_id UUID,                                  -- NULL for org-level, assistant_id or dept_id
    soft_cap_tokens BIGINT NOT NULL DEFAULT 1000000,  -- Soft cap (warning threshold)
    hard_cap_tokens BIGINT NOT NULL DEFAULT 5000000,  -- Hard cap (enforcement block)
    tokens_used BIGINT NOT NULL DEFAULT 0,
    period TEXT NOT NULL DEFAULT 'monthly',         -- 'monthly', 'daily'
    period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Token Usage Ledger (append-only, fine grained)
CREATE TABLE IF NOT EXISTS token_usage_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    assistant_id UUID,
    tokens_prompt INT NOT NULL DEFAULT 0,
    tokens_completion INT NOT NULL DEFAULT 0,
    tokens_total INT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
    trace_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. RLS on billing_quotas
ALTER TABLE billing_quotas ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_quotas_tenant_isolation ON billing_quotas
    USING (org_id::text = current_setting('app.current_org_id', true));

-- 4. RLS on token_usage_ledger
ALTER TABLE token_usage_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY token_usage_ledger_tenant_isolation ON token_usage_ledger
    USING (org_id::text = current_setting('app.current_org_id', true));

-- 5. Index for fast quota lookups
CREATE INDEX IF NOT EXISTS idx_billing_quotas_org ON billing_quotas (org_id, scope);
CREATE INDEX IF NOT EXISTS idx_token_usage_org ON token_usage_ledger (org_id, created_at);
