-- ============================================================================
-- 075_delegation_config.sql
-- ----------------------------------------------------------------------------
-- FASE 5d — Escalação Governada
--
-- Adiciona uma coluna JSONB de configuração de delegação por assistente.
-- Quando habilitado, mensagens que matcham um pattern regex são escaladas
-- para o Architect → OpenClaude para execução autônoma governada.
--
-- Estrutura do delegation_config:
--   {
--     "enabled": boolean,
--     "auto_delegate_patterns": string[],   -- regex patterns
--     "max_duration_seconds": number        -- timeout para execução delegada
--   }
-- ============================================================================

BEGIN;

ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS delegation_config JSONB
        NOT NULL DEFAULT '{"enabled": false, "auto_delegate_patterns": [], "max_duration_seconds": 300}'::jsonb;

COMMENT ON COLUMN assistants.delegation_config IS
    'Configuration for automatic delegation to Architect/OpenClaude. Fields:
     enabled: boolean — whether this assistant can delegate tasks
     auto_delegate_patterns: string[] — regex patterns that trigger delegation
     max_duration_seconds: number — maximum time for delegated execution';

-- Index para queries que filtram assistentes com delegação ativa
CREATE INDEX IF NOT EXISTS idx_assistants_delegation_enabled
    ON assistants((delegation_config->>'enabled'))
    WHERE delegation_config->>'enabled' = 'true';

COMMIT;
