-- Migration 091 — FASE 14.0/3b · Feature 1
-- =====================================================================
-- MCP server registry per org. The Claude Code CLI accepts an
-- `--mcp-config <path>` JSON file listing servers it should spawn (or
-- HTTP-connect to) for the duration of a single run. We persist those
-- definitions per-org and let callers select which subset of them a
-- particular work_item should expose.
--
-- We do NOT proxy MCP traffic — once the CLI spawns the server, that
-- subprocess talks to whatever endpoint the server's protocol defines.
-- DLP/audit coverage of MCP tool calls is captured server-side via
-- the `tool_use` envelopes the CLI surfaces (already wired into
-- runtime_work_item_events as TOOL_START / TOOL_RESULT).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS mcp_server_configs (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    transport   TEXT NOT NULL CHECK (transport IN ('stdio', 'sse', 'http')),
    -- For stdio: { "command": "...", "args": [...], "env": {...} }
    -- For sse/http: { "url": "...", "headers": {...} }
    -- Sensitive values inside `env` / `headers` are masked on read by the
    -- admin route serializer; the raw row is never exposed via API.
    config      JSONB NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_configs_org_enabled
    ON mcp_server_configs (org_id) WHERE enabled = true;

-- Per-work-item override: an array of mcp_server_configs.id values that
-- the runner should mount for this run. NULL/empty = no MCP servers
-- (current behavior preserved). Caller passes the IDs in
-- runtime_options.mcp_server_ids on /v1/execute, the api persists them
-- here, and the adapter reads back the configs at dispatch time.
ALTER TABLE runtime_work_items
    ADD COLUMN IF NOT EXISTS mcp_server_ids UUID[] DEFAULT NULL;

COMMENT ON TABLE mcp_server_configs IS
    'FASE 14.0/3b: MCP server registry per organization. Servers selected '
    'by id on a per-work-item basis via runtime_work_items.mcp_server_ids.';
COMMENT ON COLUMN runtime_work_items.mcp_server_ids IS
    'FASE 14.0/3b: subset of mcp_server_configs.id that the runner should '
    'mount for this work_item. NULL/empty means no MCP servers — same as '
    'pre-3b behavior.';

-- RLS: org_isolation_mcp policy. Standard pattern from other tenant tables.
ALTER TABLE mcp_server_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_server_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_mcp ON mcp_server_configs
    FOR ALL TO govai_app
    USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
    WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_server_configs TO govai_app;

COMMIT;
