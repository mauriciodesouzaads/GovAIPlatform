-- Migration: 051_shield_multisource_resolution.sql
-- Objetivo: Shield S1-R — network/SWG/proxy collector + correlação multissinal.
--
-- INCREMENTAL: usa IF NOT EXISTS em todos os ALTER TABLE / CREATE TABLE.
-- NÃO quebra baseline (047–049). Campos já entregues em 049 não são retocados.

BEGIN;

-- ── 1. Enriquecer shield_findings com campos de correlação multissinal ─────────
-- source_types: array JSONB de fontes que observaram a ferramenta
--   ex: ["oauth","network"]
-- correlation_count: quantas fontes distintas confirmaram o finding
-- owner_candidate_hash / owner_candidate_source já existem desde 049 — não retocar

ALTER TABLE shield_findings
    ADD COLUMN IF NOT EXISTS source_types       jsonb   NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS correlation_count  integer NOT NULL DEFAULT 1;

-- ── 2. Criar shield_network_collectors ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS shield_network_collectors (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    collector_name  text        NOT NULL,
    source_kind     text        NOT NULL CHECK (source_kind IN ('proxy','swg','network')),
    status          text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','paused','error')),
    last_sync_at    timestamptz,
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE shield_network_collectors ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'shield_network_collectors'
          AND policyname = 'shield_network_collectors_org_policy'
    ) THEN
        CREATE POLICY shield_network_collectors_org_policy
            ON shield_network_collectors
            USING (org_id::text = current_setting('app.current_org_id', true));
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON shield_network_collectors TO govai_app;

-- ── 3. Criar shield_network_events_raw ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS shield_network_events_raw (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               uuid        NOT NULL,
    collector_id         uuid        REFERENCES shield_network_collectors(id) ON DELETE SET NULL,
    tool_name            text        NOT NULL,
    tool_name_normalized text        NOT NULL,
    user_identifier_hash text,
    department_hint      text,
    observed_at          timestamptz NOT NULL,
    source_metadata      jsonb       NOT NULL DEFAULT '{}',
    raw_data             jsonb       NOT NULL DEFAULT '{}',
    processed            boolean     NOT NULL DEFAULT FALSE,
    created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE shield_network_events_raw ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'shield_network_events_raw'
          AND policyname = 'shield_network_events_raw_org_policy'
    ) THEN
        CREATE POLICY shield_network_events_raw_org_policy
            ON shield_network_events_raw
            USING (org_id::text = current_setting('app.current_org_id', true));
    END IF;
END $$;

-- Índices para processamento eficiente
CREATE INDEX IF NOT EXISTS idx_shield_net_events_pending
    ON shield_network_events_raw (org_id, processed, observed_at);

CREATE INDEX IF NOT EXISTS idx_shield_net_events_tool
    ON shield_network_events_raw (org_id, tool_name_normalized, observed_at);

GRANT SELECT, INSERT, UPDATE ON shield_network_events_raw TO govai_app;

COMMIT;
