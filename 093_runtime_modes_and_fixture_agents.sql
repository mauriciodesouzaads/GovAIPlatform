-- Migration 093 — FASE 14.0 Etapa 5b.2
-- =====================================================================
-- Modo Agente + Modo Livre: dual-mode execution under /execucoes.
--
-- BACKGROUND
-- ----------
-- Until 5b.1, every run on the platform was triggered through
-- /v1/execute/:assistantId — the assistant id was a hard required
-- parameter, and the only way to get a Claude Code / Aider / OpenClaude
-- run was to bind it to a published assistant version. The /playground
-- chat surface bypassed that path with a "Delegação Autônoma" toggle,
-- but the row it produced still pointed at an assistant via
-- execution_context.assistant_id.
--
-- 5b.2 introduces the explicit two-mode UX:
--   - Modo Agente   — pick a pre-configured assistant package
--                     (system prompt + RAG + engine + skills + MCPs +
--                     governance) — what the consultant ships to a
--                     business team. assistant_id is mandatory.
--   - Modo Livre    — pick the engine + model + MCPs inline; no
--                     assistant_id, no published version. The native
--                     harness runs under audit hooks. Used by power
--                     users / consultants to evaluate agents before
--                     publishing them.
--
-- Both modes write to runtime_work_items. To distinguish them at
-- query time and enforce invariants, this migration:
--   1. Adds runtime_work_items.assistant_id (nullable FK).
--   2. Adds runtime_work_items.execution_mode ('agent' | 'freeform').
--   3. Adds chk_agent_mode_has_assistant: agent ⇒ assistant_id NOT NULL.
--   4. Backfills existing rows from execution_context->>'assistant_id'.
--   5. Adds three columns to assistants for fixture self-description:
--        - default_mcp_server_ids
--        - default_runtime_options
--        - is_fixture
--   6. Seeds 4 fixture agents (Claude Code Livre, Claude Code Auditado,
--      Aider Pesquisa, Coding Sandbox) in the demo org with their
--      assistant_versions (system prompt + tool list).
--
-- The CHECK constraint guarantees no Modo Agente row ever lands without
-- a backing assistant — bad data for downstream RAG/policy/audit. The
-- FK is ON DELETE SET NULL so archiving an assistant doesn't cascade-
-- delete its run history (we want the audit trail).
-- =====================================================================

BEGIN;

-- ─── 1. runtime_work_items.assistant_id (nullable FK) ────────────────
--
-- Why nullable: Modo Livre rows have no assistant by definition. The
-- constraint chk_agent_mode_has_assistant (added below) enforces the
-- invariant that 'agent' mode rows MUST point at one; 'freeform' rows
-- MUST NOT — so the schema is honest without forcing every run through
-- the assistant table.
ALTER TABLE runtime_work_items
    ADD COLUMN IF NOT EXISTS assistant_id UUID
        REFERENCES assistants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_work_items_assistant
    ON runtime_work_items(assistant_id)
    WHERE assistant_id IS NOT NULL;

COMMENT ON COLUMN runtime_work_items.assistant_id IS
    'FK to assistants. NULL ⇒ Modo Livre (freeform) run. NOT NULL ⇒ Modo Agente run. Enforced by chk_agent_mode_has_assistant.';

-- ─── 2. runtime_work_items.execution_mode ────────────────────────────
ALTER TABLE runtime_work_items
    ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'agent';

ALTER TABLE runtime_work_items
    DROP CONSTRAINT IF EXISTS runtime_work_items_execution_mode_check;
ALTER TABLE runtime_work_items
    ADD CONSTRAINT runtime_work_items_execution_mode_check
    CHECK (execution_mode IN ('agent', 'freeform'));

COMMENT ON COLUMN runtime_work_items.execution_mode IS
    'agent = bound to assistants(id); freeform = inline harness/model (consultant or power-user evaluation flow). Default agent for backwards-compat with the 5b.1 cohort.';

-- ─── 3. Backfill assistant_id from execution_context ─────────────────
--
-- Every existing row was created via the delegation pipeline, which
-- stamps execution_context.assistant_id. Lift that into the column so
-- the constraint passes.
UPDATE runtime_work_items
   SET assistant_id = (execution_context->>'assistant_id')::uuid
 WHERE assistant_id IS NULL
   AND execution_context ? 'assistant_id'
   AND execution_context->>'assistant_id' ~ '^[0-9a-fA-F-]{36}$'
   AND EXISTS (
       SELECT 1 FROM assistants a
        WHERE a.id::text = execution_context->>'assistant_id'
   );

-- For any leftovers (orphan-context rows, deleted assistants), flip
-- them to freeform so the constraint can be added without a NULL
-- collision in 'agent' mode.
UPDATE runtime_work_items
   SET execution_mode = 'freeform'
 WHERE assistant_id IS NULL;

-- ─── 4. CHECK constraint: agent mode requires assistant ──────────────
ALTER TABLE runtime_work_items
    DROP CONSTRAINT IF EXISTS chk_agent_mode_has_assistant;
ALTER TABLE runtime_work_items
    ADD CONSTRAINT chk_agent_mode_has_assistant
    CHECK (
        (execution_mode = 'agent'    AND assistant_id IS NOT NULL)
        OR
        (execution_mode = 'freeform' AND assistant_id IS NULL)
    );

-- ─── 5. assistants: fixture self-description ─────────────────────────
--
-- These three columns let a fixture agent describe its full runtime
-- recipe (engine + MCPs + thinking knobs + subagent flag) without
-- relying on delegation_config JSONB conventions. Modo Agente reads
-- them to pre-populate the run; the user only picks the agent and
-- types the prompt.
ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS default_mcp_server_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS default_runtime_options JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS is_fixture BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN assistants.default_mcp_server_ids IS
    'MCP server config IDs to mount on every run of this agent. Modo Agente surfaces these as the implicit toolset.';
COMMENT ON COLUMN assistants.default_runtime_options IS
    'Runtime knobs forwarded to the gRPC adapter on every run. Same shape as the /v1/execute body field runtime_options: {enable_thinking, thinking_budget_tokens, enable_subagents, model}.';
COMMENT ON COLUMN assistants.is_fixture IS
    'TRUE for seeded demo agents shipped with the platform. UI hides the delete button on these and shows a "fixture" badge.';

-- ─── 6. Seed the 4 fixture agents in the demo org ────────────────────
--
-- The fixed UUIDs (0fff-...) make them addressable from the smoke
-- tests without a SELECT BY name dance. They land in the demo org
-- (00...0001). Production tenants get them via seed.sql or are
-- expected to author their own.
--
-- Each agent describes ONE governance posture:
--   - Claude Code Livre   — engine claude_code_official, full tools,
--                           subagents, thinking high. The honest
--                           "show me the harness" flagship.
--   - Claude Code Auditado — same engine, but with explicit DLP/PII
--                           gates and shield_level=2 enforced.
--   - Aider Pesquisa      — aider engine for code-grounded research /
--                           long-horizon refactors.
--   - Coding Sandbox      — openclaude (curated tools only) for safe
--                           coding tasks against unverified inputs.
--
-- All four target the demo org (00...0001) and reuse the existing
-- "Política Padrão" policy version (00...0003-...0001). Their
-- assistant_versions carry the system prompt; tools_jsonb is left
-- empty since the runtime layer (claude-code CLI / aider / openclaude)
-- decides the toolset based on default_runtime_options.

DO $$
DECLARE
    demo_org      UUID := '00000000-0000-0000-0000-000000000001';
    default_pv    UUID := '00000000-0000-0000-0003-000000000001';
    livre_id      UUID := '00000000-0000-0000-0fff-000000000001';
    auditado_id   UUID := '00000000-0000-0000-0fff-000000000002';
    aider_id      UUID := '00000000-0000-0000-0fff-000000000003';
    sandbox_id    UUID := '00000000-0000-0000-0fff-000000000004';

    livre_v_id    UUID := uuid_generate_v4();
    auditado_v_id UUID := uuid_generate_v4();
    aider_v_id    UUID := uuid_generate_v4();
    sandbox_v_id  UUID := uuid_generate_v4();
BEGIN
    -- Bail out cleanly if the policy version doesn't exist (fresh stack
    -- without seed.sh would have applied this; in that case the
    -- migration finishes without seeding fixtures and seed.sh re-runs
    -- can pick them up).
    IF NOT EXISTS (SELECT 1 FROM policy_versions WHERE id = default_pv) THEN
        RAISE NOTICE 'Default policy version % not found — skipping fixture seed', default_pv;
        RETURN;
    END IF;

    -- ── Claude Code Livre ────────────────────────────────────────────
    INSERT INTO assistants (
        id, org_id, name, description, status, lifecycle_state,
        runtime_profile_slug, runtime_selection_mode,
        default_runtime_options, is_fixture, shield_level
    )
    VALUES (
        livre_id, demo_org,
        'Claude Code Livre',
        'Claude Code rodando em modo livre — todas as ferramentas habilitadas, subagentes via Task, thinking estendido. Auditado em segundo plano.',
        'published', 'official',
        'claude_code_official', 'fixed',
        jsonb_build_object(
            'enable_subagents', true,
            'enable_thinking',  true,
            'thinking_budget_tokens', 8000
        ),
        true, 1
    )
    ON CONFLICT (id) DO UPDATE SET
        runtime_profile_slug   = EXCLUDED.runtime_profile_slug,
        runtime_selection_mode = EXCLUDED.runtime_selection_mode,
        default_runtime_options= EXCLUDED.default_runtime_options,
        is_fixture             = EXCLUDED.is_fixture;

    INSERT INTO assistant_versions (
        id, org_id, assistant_id, policy_version_id,
        prompt, tools_jsonb, version, status, published_at
    )
    VALUES (
        livre_v_id, demo_org, livre_id, default_pv,
        E'Você é o Claude Code rodando dentro da plataforma GovAI sob auditoria.\nTodas as suas ações são gravadas (audit hooks) e revisáveis em /execucoes.\nUse ferramentas livremente — Read/Write/Edit/Bash/Task/Glob/Grep/WebFetch — mas declare a intenção antes de executar comandos destrutivos. Ao terminar, reporte o que foi alterado e onde.',
        '[]'::jsonb, 1, 'published', NOW()
    )
    ON CONFLICT (id) DO NOTHING;

    UPDATE assistants SET current_version_id = livre_v_id
     WHERE id = livre_id AND current_version_id IS NULL;

    -- ── Claude Code Auditado ─────────────────────────────────────────
    INSERT INTO assistants (
        id, org_id, name, description, status, lifecycle_state,
        runtime_profile_slug, runtime_selection_mode,
        default_runtime_options, is_fixture,
        shield_level, pii_blocker_enabled, data_classification
    )
    VALUES (
        auditado_id, demo_org,
        'Claude Code Auditado',
        'Claude Code com governança máxima: DLP estrito, HITL para comandos destrutivos, shield_level=2. Para ambientes onde cada ação precisa de paper trail formal.',
        'published', 'official',
        'claude_code_official', 'fixed',
        jsonb_build_object(
            'enable_subagents', true,
            'enable_thinking',  true,
            'thinking_budget_tokens', 4000
        ),
        true, 2, true, 'confidential'
    )
    ON CONFLICT (id) DO UPDATE SET
        runtime_profile_slug   = EXCLUDED.runtime_profile_slug,
        runtime_selection_mode = EXCLUDED.runtime_selection_mode,
        default_runtime_options= EXCLUDED.default_runtime_options,
        shield_level           = EXCLUDED.shield_level,
        pii_blocker_enabled    = EXCLUDED.pii_blocker_enabled,
        data_classification    = EXCLUDED.data_classification,
        is_fixture             = EXCLUDED.is_fixture;

    INSERT INTO assistant_versions (
        id, org_id, assistant_id, policy_version_id,
        prompt, tools_jsonb, version, status, published_at
    )
    VALUES (
        auditado_v_id, demo_org, auditado_id, default_pv,
        E'Você é o Claude Code rodando sob auditoria reforçada.\nAntes de qualquer comando que modifique arquivos ou estado externo, descreva o que pretende fazer e por quê. Comandos destrutivos (rm, drop, force-push) ficam bloqueados pela política Shield e devem ser delegados ao operador humano. PII em outputs é mascarado automaticamente; trate dados sensíveis com cuidado redobrado.',
        '[]'::jsonb, 1, 'published', NOW()
    )
    ON CONFLICT (id) DO NOTHING;

    UPDATE assistants SET current_version_id = auditado_v_id
     WHERE id = auditado_id AND current_version_id IS NULL;

    -- ── Aider Pesquisa ───────────────────────────────────────────────
    INSERT INTO assistants (
        id, org_id, name, description, status, lifecycle_state,
        runtime_profile_slug, runtime_selection_mode,
        default_runtime_options, is_fixture, shield_level
    )
    VALUES (
        aider_id, demo_org,
        'Aider Pesquisa',
        'Aider em modo pesquisa — leitura de código + edição assistida. Bom para refatoração de longo horizonte e exploração de codebases grandes. Mantém histórico de sessão por work item.',
        'published', 'official',
        'aider', 'fixed',
        '{}'::jsonb,
        true, 1
    )
    ON CONFLICT (id) DO UPDATE SET
        runtime_profile_slug   = EXCLUDED.runtime_profile_slug,
        runtime_selection_mode = EXCLUDED.runtime_selection_mode,
        is_fixture             = EXCLUDED.is_fixture;

    INSERT INTO assistant_versions (
        id, org_id, assistant_id, policy_version_id,
        prompt, tools_jsonb, version, status, published_at
    )
    VALUES (
        aider_v_id, demo_org, aider_id, default_pv,
        E'Você é o Aider rodando sob a plataforma GovAI. Foque em compreender o código antes de propor mudanças. Faça commits pequenos e descritivos. Quando a tarefa for ambígua, peça esclarecimento em vez de assumir.',
        '[]'::jsonb, 1, 'published', NOW()
    )
    ON CONFLICT (id) DO NOTHING;

    UPDATE assistants SET current_version_id = aider_v_id
     WHERE id = aider_id AND current_version_id IS NULL;

    -- ── Coding Sandbox ───────────────────────────────────────────────
    INSERT INTO assistants (
        id, org_id, name, description, status, lifecycle_state,
        runtime_profile_slug, runtime_selection_mode,
        default_runtime_options, is_fixture, shield_level,
        pii_blocker_enabled, data_classification
    )
    VALUES (
        sandbox_id, demo_org,
        'Coding Sandbox',
        'OpenClaude com tooling enxuto (sem subagentes, sem WebFetch). Ambiente seguro para tarefas de código contra inputs não verificados. DLP estrito, shield_level=3.',
        'published', 'official',
        'openclaude', 'fixed',
        jsonb_build_object(
            'enable_subagents', false,
            'enable_thinking',  false
        ),
        true, 3, true, 'restricted'
    )
    ON CONFLICT (id) DO UPDATE SET
        runtime_profile_slug   = EXCLUDED.runtime_profile_slug,
        runtime_selection_mode = EXCLUDED.runtime_selection_mode,
        default_runtime_options= EXCLUDED.default_runtime_options,
        shield_level           = EXCLUDED.shield_level,
        pii_blocker_enabled    = EXCLUDED.pii_blocker_enabled,
        data_classification    = EXCLUDED.data_classification,
        is_fixture             = EXCLUDED.is_fixture;

    INSERT INTO assistant_versions (
        id, org_id, assistant_id, policy_version_id,
        prompt, tools_jsonb, version, status, published_at
    )
    VALUES (
        sandbox_v_id, demo_org, sandbox_id, default_pv,
        E'Você opera em ambiente sandbox com ferramentas restritas. Não tem acesso à internet (WebFetch off) nem pode delegar a subagentes. Foque em raciocínio explícito e código verificável. Inputs externos são tratados como não confiáveis — valide antes de executar.',
        '[]'::jsonb, 1, 'published', NOW()
    )
    ON CONFLICT (id) DO NOTHING;

    UPDATE assistants SET current_version_id = sandbox_v_id
     WHERE id = sandbox_id AND current_version_id IS NULL;

    RAISE NOTICE 'Seeded 4 fixture agents in demo org %', demo_org;
END $$;

-- ─── Sanity checks ───────────────────────────────────────────────────
DO $$
DECLARE
    fixture_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO fixture_count
      FROM assistants
     WHERE is_fixture = TRUE
       AND org_id = '00000000-0000-0000-0000-000000000001';

    IF fixture_count < 4 THEN
        RAISE WARNING 'Expected 4 fixture agents, found %', fixture_count;
    END IF;

    -- Constraint must be honored on existing rows.
    IF EXISTS (
        SELECT 1 FROM runtime_work_items
         WHERE (execution_mode = 'agent'    AND assistant_id IS NULL)
            OR (execution_mode = 'freeform' AND assistant_id IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'chk_agent_mode_has_assistant violation in existing rows';
    END IF;
END $$;

COMMIT;
