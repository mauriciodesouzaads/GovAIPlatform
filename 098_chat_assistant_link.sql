-- Migration 098 — FASE 14.0/6c.A.1
-- =====================================================================
-- Vínculo Catálogo↔Chat↔Execuções:
--
--   * chat_conversations.assistant_id      — quando setado, conversation
--                                            usa system_prompt + KBs +
--                                            skills + MCPs do agente.
--                                            NULL = chat livre (passthrough).
--   * chat_messages.work_item_id           — link bidirecional Chat↔Modo Code
--                                            (preparação 6c.B). NULL para
--                                            mensagens geradas por LiteLLM
--                                            puro (Modo Chat).
--   * assistants extensão                  — system_prompt (column nova,
--                                            denormalizada de assistant_versions
--                                            para chat consumption simples),
--                                            category, default_engine,
--                                            default_model, default_temperature,
--                                            avatar_emoji, suggested_prompts.
--
-- A recon confirmou que `assistants.system_prompt` NÃO existe (legacy
-- sempre buscou via assistant_versions.prompt). Adicionamos a coluna
-- nessa migration porque o consumo via chat exige um SELECT de uma
-- linha só — JOIN em assistant_versions na hot path do streaming
-- adicionaria latência sem benefício. A coluna espelha o prompt da
-- versão atual; trocar no UPDATE faz parte do fluxo de seed dos
-- agentes verticais.
-- =====================================================================

BEGIN;

-- ─── 1. chat_conversations.assistant_id ──────────────────────────────
ALTER TABLE chat_conversations
    ADD COLUMN IF NOT EXISTS assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_conv_assistant
    ON chat_conversations(assistant_id)
    WHERE assistant_id IS NOT NULL;

COMMENT ON COLUMN chat_conversations.assistant_id IS
    'Quando setado, conversation usa system_prompt + KBs + skills do agente. '
    'NULL = chat livre (passthrough LiteLLM sem system prompt customizado).';

-- ─── 2. chat_messages.work_item_id ───────────────────────────────────
ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS work_item_id UUID REFERENCES runtime_work_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_msg_wi
    ON chat_messages(work_item_id)
    WHERE work_item_id IS NOT NULL;

COMMENT ON COLUMN chat_messages.work_item_id IS
    'Quando assistant message foi gerada por dispatchWorkItem (Modo Code, 6c.B), '
    'aponta para runtime_work_items para link bidirecional Chat↔Execuções. '
    'NULL para mensagens geradas por LiteLLM passthrough (Modo Chat).';

-- ─── 3. assistants — extensão para personalidade vertical ────────────
ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS system_prompt TEXT,
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS default_engine TEXT NOT NULL DEFAULT 'claude_code_official',
    ADD COLUMN IF NOT EXISTS default_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    ADD COLUMN IF NOT EXISTS default_temperature NUMERIC(3,2) NOT NULL DEFAULT 0.7,
    ADD COLUMN IF NOT EXISTS avatar_emoji TEXT,
    ADD COLUMN IF NOT EXISTS suggested_prompts JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN assistants.system_prompt IS
    'System prompt rico do agente (1500-3000 chars). Denormalizado de '
    'assistant_versions.prompt para chat consumption simples (single-row '
    'SELECT no hot path do streaming). Atualize aqui quando publicar nova '
    'versão; consistência fica com o admin construtor que escreve em '
    'ambos os lugares.';

COMMENT ON COLUMN assistants.category IS
    'general | technical | juridico | compliance | financeiro | rh | atendimento. '
    'UI catálogo agrupa por category; default general.';

COMMENT ON COLUMN assistants.suggested_prompts IS
    'Array de strings com sugestões iniciais que aparecem como chips '
    'clicáveis no empty state da conversa quando agente é selecionado.';

-- ─── 4. Backfill: marcar agentes técnicos existentes ────────────────
-- Os 4 fixtures originais (Claude Code Livre/Auditado, Aider Pesquisa,
-- Coding Sandbox) viram category='technical' para distinguir dos
-- 4 verticais que serão seedados neste etapa. Os outros (Chatbot
-- Atendimento, etc) ficam category='general'.
UPDATE assistants
   SET category = 'technical'
 WHERE name IN ('Claude Code Livre', 'Claude Code Auditado',
                'Aider Pesquisa', 'Coding Sandbox')
   AND category = 'general';

-- ─── 5. Sanity ───────────────────────────────────────────────────────
DO $$
DECLARE
    n_cols INT;
BEGIN
    SELECT COUNT(*) INTO n_cols
      FROM information_schema.columns
     WHERE (table_name = 'chat_conversations' AND column_name = 'assistant_id')
        OR (table_name = 'chat_messages' AND column_name = 'work_item_id')
        OR (table_name = 'assistants'
            AND column_name IN
                ('system_prompt', 'category', 'default_engine',
                 'default_model', 'default_temperature', 'avatar_emoji',
                 'suggested_prompts'));
    IF n_cols < 9 THEN
        RAISE EXCEPTION 'Migration 098 incomplete (got %, need 9)', n_cols;
    END IF;
    RAISE NOTICE 'Migration 098 OK — % columns added/extended', n_cols;
END $$;

COMMIT;
