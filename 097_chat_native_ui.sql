-- Migration 097 — FASE 14.0/6c.A
-- =====================================================================
-- Chat nativo do usuário final (modo "Claude Desktop-like" sob /chat).
--
-- Antes desta migration, /v1/admin/chat/* era a única superfície de
-- chat e mantinha sessões em Redis (efêmeras, perdiam ao reiniciar
-- a api). O novo /v1/chat/* expõe um produto separado com:
--
--   * conversas persistentes com title/pinned/archived
--   * histórico ilimitado por conversa (paginado)
--   * mode discriminator (chat | code | cowork) preparado para 6c.B/C
--   * default_model por conversa (multi-LLM via LiteLLM)
--   * knowledge_base_ids[] para RAG escopado à conversa
--   * attachments com extracted_text para chat com PDFs/DOCXs
--   * llm_providers como catálogo seedado (não hardcoded em TS)
--
-- O legacy /v1/admin/chat/* fica intacto — ele tem consumers
-- diferentes (admin tools com session_id em cookie). Refator dessa
-- camada vem em uma etapa de cleanup separada quando ninguém usar.
-- =====================================================================

BEGIN;

-- ─── 1. chat_conversations ───────────────────────────────────────────
-- A conversa é a unidade de UX no /chat: o usuário cria uma "Nova
-- conversa", troca mensagens, eventualmente arquiva ou pina. Cada
-- conversa carrega o modelo default que herda nas próximas mensagens
-- (pode ser sobrescrito por mensagem individual via column message.model).
CREATE TABLE IF NOT EXISTS chat_conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT 'Nova conversa',
    -- mode prepara terreno para 6c.B (code) e 6c.C (cowork). Por ora
    -- o seletor da UI mostra só 'chat' — as outras opções ficam atrás
    -- de feature flag até a etapa correspondente.
    mode TEXT NOT NULL DEFAULT 'chat',
    default_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    -- KBs linkadas ao escopo da conversa: RAG hook (6a₁) busca aqui.
    -- Vazio = no retrieval. Single source of truth — não há linkagem
    -- por mensagem (decidiríamos em 6c.B se virar caso de uso).
    knowledge_base_ids UUID[] NOT NULL DEFAULT '{}',
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ
);

ALTER TABLE chat_conversations
    DROP CONSTRAINT IF EXISTS chat_conversations_mode_check;
ALTER TABLE chat_conversations
    ADD CONSTRAINT chat_conversations_mode_check
    CHECK (mode IN ('chat', 'code', 'cowork'));

-- Index principal: sidebar list query — por org, não-arquivadas,
-- ordenadas por última atividade.
CREATE INDEX IF NOT EXISTS idx_chat_conv_sidebar
    ON chat_conversations(org_id, archived, last_message_at DESC NULLS LAST)
    WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_chat_conv_user
    ON chat_conversations(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_conv_pinned
    ON chat_conversations(org_id, last_message_at DESC NULLS LAST)
    WHERE pinned = TRUE AND archived = FALSE;

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_conv_org_isolation ON chat_conversations;
CREATE POLICY chat_conv_org_isolation ON chat_conversations
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversations TO govai_app;

CREATE OR REPLACE FUNCTION update_chat_conversations_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_chat_conv_updated ON chat_conversations;
CREATE TRIGGER trg_chat_conv_updated
    BEFORE UPDATE ON chat_conversations
    FOR EACH ROW EXECUTE FUNCTION update_chat_conversations_updated_at();

-- ─── 2. chat_messages ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    -- model NULL para role='user' (ainda não foi escolhido); preenchido
    -- para 'assistant' com o alias LiteLLM que produziu a resposta.
    model TEXT,
    tokens_in INT,
    tokens_out INT,
    latency_ms INT,
    finish_reason TEXT,
    -- tool_calls preserva qualquer call que o LLM fizer (function calling
    -- via API openai-compatible do LiteLLM). Default null porque a maioria
    -- das mensagens não tem tool calls.
    tool_calls JSONB,
    attachments_ids UUID[] NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    -- DLP scan result em formato { has_pii, hits: [...], action: ... }
    -- da função scanDocumentForPII. user messages que retornam action=block
    -- não chegam a virar row aqui — são rejeitadas com 422 antes do INSERT.
    -- Salvamos quando há detection sem block (ALERT/REDACT) para auditoria.
    dlp_scan JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chat_messages
    DROP CONSTRAINT IF EXISTS chat_messages_role_check;
ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_role_check
    CHECK (role IN ('user', 'assistant', 'system', 'tool'));

CREATE INDEX IF NOT EXISTS idx_chat_msg_conv
    ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_msg_org
    ON chat_messages(org_id);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_msg_org_isolation ON chat_messages;
CREATE POLICY chat_msg_org_isolation ON chat_messages
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO govai_app;

-- ─── 3. chat_attachments ─────────────────────────────────────────────
-- Arquivos anexados a uma conversa (PDF, DOCX, imagem, etc.). O
-- extractor gera extracted_text que vira contexto na próxima mensagem
-- via injeção no system prompt (similar ao caminho RAG mas escopo
-- conversa, não KB).
CREATE TABLE IF NOT EXISTS chat_attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    extracted_text TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_att_conv ON chat_attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_att_org ON chat_attachments(org_id);

ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_att_org_isolation ON chat_attachments;
CREATE POLICY chat_att_org_isolation ON chat_attachments
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_attachments TO govai_app;

-- ─── 4. llm_providers — catálogo de modelos ──────────────────────────
-- Source of truth para o dropdown de seleção de modelo na UI.
-- Não tem RLS — é global, igual para todas as orgs. As linhas refletem
-- exatamente os aliases configurados em litellm-config.yaml.
--
-- capabilities é um array textual de tags ("vision", "extended_thinking",
-- etc.) que a UI renderiza como mini-pills na descrição do modelo.
-- IMPORTANTE: capabilities é INFORMATIVO (descreve o que o modelo
-- suporta), NÃO é toggle interativo. Cada provider tem sua própria
-- forma de invocar tools (vision/web_search/etc.) e expor toggle UI
-- sem wirar até cada integração violaria o princípio "sem placeholder
-- visível ao usuário".
CREATE TABLE IF NOT EXISTS llm_providers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider TEXT NOT NULL,
    -- model_id corresponde ao alias em litellm-config.yaml (não ao
    -- model real do provider). A UI manda esse valor no campo `model`
    -- da request a /v1/chat/.../messages, e a api forward direto pro
    -- LiteLLM em /v1/chat/completions.
    model_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    context_window INT,
    max_output INT,
    capabilities JSONB NOT NULL DEFAULT '[]',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    icon_emoji TEXT,
    -- sort_order define a posição no dropdown. Anthropic top, depois
    -- OpenAI, depois Google. Dentro de cada grupo, mais capaz primeiro.
    sort_order INT NOT NULL DEFAULT 100,
    UNIQUE (provider, model_id)
);

INSERT INTO llm_providers
    (provider, model_id, display_name, description, context_window, max_output,
     capabilities, is_default, icon_emoji, sort_order)
VALUES
    ('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7',
     'Mais capaz, raciocínio profundo, melhor para tarefas complexas',
     200000, 32000, '["vision", "extended_thinking"]'::jsonb,
     FALSE, '🟣', 10),

    ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6',
     'Equilíbrio velocidade/capacidade — recomendado',
     200000, 16000, '["vision", "extended_thinking"]'::jsonb,
     TRUE, '🟢', 20),

    ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5',
     'Rápido e econômico para conversas curtas',
     200000, 8000, '["vision"]'::jsonb,
     FALSE, '🟡', 30),

    ('openai', 'gpt-4o', 'GPT-4o',
     'OpenAI multimodal, generalista',
     128000, 16000, '["vision"]'::jsonb,
     FALSE, '⚫', 40),

    ('openai', 'gpt-4o-mini', 'GPT-4o mini',
     'OpenAI rápido e barato',
     128000, 16000, '["vision"]'::jsonb,
     FALSE, '⚫', 50),

    ('google', 'gemini-2-flash', 'Gemini 2.5 Flash',
     'Google multimodal rápido com janela longa',
     1000000, 8000, '["vision"]'::jsonb,
     FALSE, '🔵', 60)
ON CONFLICT (provider, model_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description  = EXCLUDED.description,
    context_window = EXCLUDED.context_window,
    max_output     = EXCLUDED.max_output,
    capabilities   = EXCLUDED.capabilities,
    is_default     = EXCLUDED.is_default,
    icon_emoji     = EXCLUDED.icon_emoji,
    sort_order     = EXCLUDED.sort_order;

GRANT SELECT ON llm_providers TO govai_app;

-- ─── 5. Sanity checks ────────────────────────────────────────────────
DO $$
DECLARE
    n_tables INT;
    n_providers INT;
BEGIN
    SELECT COUNT(*) INTO n_tables
      FROM information_schema.tables
     WHERE table_name IN
        ('chat_conversations', 'chat_messages', 'chat_attachments', 'llm_providers');
    IF n_tables < 4 THEN
        RAISE EXCEPTION 'Migration 097: expected 4 chat tables, got %', n_tables;
    END IF;

    SELECT COUNT(*) INTO n_providers FROM llm_providers WHERE is_enabled;
    IF n_providers < 6 THEN
        RAISE EXCEPTION 'Migration 097: expected 6+ enabled llm_providers, got %', n_providers;
    END IF;

    RAISE NOTICE 'Migration 097 OK — % chat tables + % enabled providers',
                 n_tables, n_providers;
END $$;

COMMIT;
