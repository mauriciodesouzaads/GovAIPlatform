-- Migration 096 — FASE 14.0/6a₂
-- =====================================================================
-- Skills híbridas + workspace outputs.
--
-- Estende a tabela `catalog_skills` (que já existe desde a 074) com
-- os campos necessários para o tipo "anthropic" (pacote SKILL.md +
-- arquivos auxiliares). Skills tipo "prompt" continuam funcionando
-- com `instructions` como antes — backwards compat.
--
-- Cria duas tabelas novas:
--   - skill_files:        arquivos auxiliares de skills anthropic-style.
--   - work_item_outputs:  arquivos gerados pelo agente durante a
--                         execução, expostos para download via
--                         /v1/admin/runtime/work-items/:id/files.
--
-- Não usamos os nomes `skills` / `assistant_skills` do brief porque
-- o catálogo da plataforma já se chama catalog_skills/
-- assistant_skill_bindings desde 5c. Renomear seria uma operação
-- arriscada que toca runtime-delegation, skills.routes, audit logs
-- e seed.sh — sem upside além de "casar com o brief verbatim".
-- =====================================================================

BEGIN;

-- ─── 1. catalog_skills — extensão para hybrid ────────────────────────
ALTER TABLE catalog_skills
    ADD COLUMN IF NOT EXISTS skill_type TEXT NOT NULL DEFAULT 'prompt',
    ADD COLUMN IF NOT EXISTS skill_md_content TEXT,
    ADD COLUMN IF NOT EXISTS skill_md_frontmatter JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS file_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_size_bytes BIGINT NOT NULL DEFAULT 0;

ALTER TABLE catalog_skills
    DROP CONSTRAINT IF EXISTS catalog_skills_skill_type_check;
ALTER TABLE catalog_skills
    ADD CONSTRAINT catalog_skills_skill_type_check
    CHECK (skill_type IN ('prompt', 'anthropic'));

COMMENT ON COLUMN catalog_skills.skill_type IS
    'prompt = system_prompt template em catalog_skills.instructions; '
    'anthropic = pacote SKILL.md + arquivos em skill_files, montado em '
    '/mnt/skills/<org>/<skill_id>/ no runner via volume Docker.';
COMMENT ON COLUMN catalog_skills.skill_md_content IS
    'Conteúdo bruto do SKILL.md (incluindo frontmatter YAML). NULL para '
    'skills tipo prompt.';
COMMENT ON COLUMN catalog_skills.skill_md_frontmatter IS
    'Frontmatter parseado do SKILL.md (YAML → jsonb). Espera-se '
    '{ name, description, category?, tags? } no formato anthropic/skills.';

CREATE INDEX IF NOT EXISTS idx_catalog_skills_type
    ON catalog_skills(org_id, skill_type)
    WHERE is_active = TRUE;

-- ─── 2. skill_files — arquivos auxiliares (apenas para 'anthropic') ──
CREATE TABLE IF NOT EXISTS skill_files (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    skill_id        UUID NOT NULL REFERENCES catalog_skills(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    relative_path   TEXT NOT NULL,    -- ex: "scripts/extract.py", "examples/case.md"
    mime_type       TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    sha256          TEXT NOT NULL,
    storage_path    TEXT NOT NULL,    -- caminho real no volume skills_storage
    is_executable   BOOLEAN NOT NULL DEFAULT FALSE,
    content_preview TEXT,             -- primeiros 500 chars (texto apenas)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (skill_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_skill_files_skill ON skill_files(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_files_org   ON skill_files(org_id);

ALTER TABLE skill_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_files_isolation ON skill_files;
CREATE POLICY skill_files_isolation ON skill_files
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_files TO govai_app;

-- ─── 3. work_item_outputs — arquivos gerados pelo agente ─────────────
-- Populated by the post-RUN_COMPLETED scan in runtime-delegation:
-- the workspace dir for a given (org, work_item) is walked and every
-- file the agent wrote becomes a row here. The UI then exposes them
-- via /v1/admin/runtime/work-items/:id/files for download.
CREATE TABLE IF NOT EXISTS work_item_outputs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_item_id  UUID NOT NULL REFERENCES runtime_work_items(id) ON DELETE CASCADE,
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,    -- relative to the work_item's workspace root
    mime_type     TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL,
    sha256        TEXT NOT NULL,
    storage_path  TEXT NOT NULL,    -- absolute path inside the workspaces volume
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,      -- TTL (NULL = persistente; cron futuro varre)
    UNIQUE (work_item_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_work_item_outputs_wi
    ON work_item_outputs(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_item_outputs_org
    ON work_item_outputs(org_id);
CREATE INDEX IF NOT EXISTS idx_work_item_outputs_expires
    ON work_item_outputs(expires_at)
    WHERE expires_at IS NOT NULL;

ALTER TABLE work_item_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_outputs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_item_outputs_isolation ON work_item_outputs;
CREATE POLICY work_item_outputs_isolation ON work_item_outputs
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON work_item_outputs TO govai_app;

-- ─── 4. Backfill skill_type para as 3 skills system existentes ───────
-- Já são tipo 'prompt' pela natureza (instructions populadas, sem
-- skill_md_content). O default DA coluna já é 'prompt' — esta linha é
-- defensiva caso alguém aplique a migration em ordem inesperada.
UPDATE catalog_skills SET skill_type = 'prompt'
 WHERE skill_type IS NULL OR skill_type = '';

-- ─── 5. Sanity checks ────────────────────────────────────────────────
DO $$
DECLARE
    cs_extended INT;
    fs_exists   INT;
    out_exists  INT;
    n_system    INT;
BEGIN
    SELECT COUNT(*) INTO cs_extended
      FROM information_schema.columns
     WHERE table_name = 'catalog_skills'
       AND column_name IN ('skill_type', 'skill_md_content',
                           'skill_md_frontmatter', 'file_count',
                           'total_size_bytes');
    IF cs_extended < 5 THEN
        RAISE EXCEPTION 'catalog_skills extension incomplete (got %, need 5)', cs_extended;
    END IF;

    SELECT COUNT(*) INTO fs_exists
      FROM information_schema.tables WHERE table_name = 'skill_files';
    IF fs_exists < 1 THEN RAISE EXCEPTION 'skill_files table missing'; END IF;

    SELECT COUNT(*) INTO out_exists
      FROM information_schema.tables WHERE table_name = 'work_item_outputs';
    IF out_exists < 1 THEN RAISE EXCEPTION 'work_item_outputs table missing'; END IF;

    SELECT COUNT(*) INTO n_system
      FROM catalog_skills WHERE is_system = TRUE;
    IF n_system < 3 THEN
        RAISE WARNING 'Expected 3+ system skills, found %', n_system;
    END IF;

    RAISE NOTICE 'Migration 096 OK — catalog_skills extended, skill_files + work_item_outputs created';
END $$;

COMMIT;
