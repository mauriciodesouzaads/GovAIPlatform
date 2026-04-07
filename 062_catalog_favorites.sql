-- ============================================================================
-- Migration 062 — Catalog Favorites + Webhook Notification System (FASE-C1)
-- ============================================================================

BEGIN;

-- ── PART A: Catalog Favorites ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS catalog_favorites (
    id           uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    created_at   timestamptz DEFAULT now(),
    UNIQUE(user_id, assistant_id)
);

ALTER TABLE catalog_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_favorites FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_favorites_isolation ON catalog_favorites
    FOR ALL TO govai_app
    USING  (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON catalog_favorites TO govai_app;

-- Usage tracking columns for "Recentes" tab
ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
    ADD COLUMN IF NOT EXISTS use_count    integer DEFAULT 0;

-- ── PART B: Webhook Configuration ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_configs (
    id         uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name       varchar(100) NOT NULL,
    url        text NOT NULL,
    secret     text,
    events     text[] NOT NULL DEFAULT '{}',
    is_active  boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id             uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    webhook_id     uuid NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
    event          text NOT NULL,
    payload        jsonb NOT NULL,
    status         varchar(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
    response_code  integer,
    response_body  text,
    attempts       integer DEFAULT 0,
    next_retry_at  timestamptz,
    created_at     timestamptz DEFAULT now()
);

ALTER TABLE webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_configs_isolation ON webhook_configs
    FOR ALL TO govai_app
    USING  (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_isolation ON webhook_deliveries
    FOR ALL TO govai_app
    USING  (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_configs   TO govai_app;
GRANT SELECT, INSERT, UPDATE         ON webhook_deliveries TO govai_app;

COMMIT;
