-- Migration 099 — FASE 14.0/6c.B
-- =====================================================================
-- Modo Code dentro de /chat: cada turn pode ser 'chat' (LiteLLM
-- passthrough — comportamento padrão da 6c.A) ou 'code'
-- (dispatchWorkItem com Claude Code SDK 100% nativo via 5b.2).
--
-- Diferente de chat_conversations.mode (lá é o "tipo da conversa"
-- como disposição inicial). chat_messages.mode é o "tipo do turn"
-- — mesma conversation pode alternar entre turns chat e code.
--
-- Não precisamos de nova coluna em runtime_work_items: a recon
-- confirmou que a tabela tem `execution_context` JSONB que já é o
-- kitchen-sink para metadata. Usaremos:
--   execution_context.source = 'chat'
--   execution_context.conversation_id = <uuid>
--   execution_context.chat_user_message_id = <uuid>
-- Nada novo no schema do runtime_work_items.
--
-- chat_messages.work_item_id já foi adicionado em 098 (mesma migração
-- que linkou chat_conversations a assistants). Esta migration só
-- adiciona `mode` para diferenciar turns dentro do chat.
-- =====================================================================

BEGIN;

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'chat';

ALTER TABLE chat_messages
    DROP CONSTRAINT IF EXISTS chat_messages_mode_check;
ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_mode_check
    CHECK (mode IN ('chat', 'code', 'cowork'));

CREATE INDEX IF NOT EXISTS idx_chat_msg_mode ON chat_messages(mode);

COMMENT ON COLUMN chat_messages.mode IS
    'chat = LiteLLM passthrough multi-LLM (6c.A). '
    'code = dispatchWorkItem (Claude Code SDK 100% nativo, 5b.2 pipeline). '
    'cowork = orquestração multi-agente (6c.C). '
    'Default chat — backwards-compat com 6c.A/6c.A.1.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name='chat_messages' AND column_name='mode'
    ) THEN
        RAISE EXCEPTION 'chat_messages.mode missing';
    END IF;
    RAISE NOTICE 'Migration 099 OK';
END $$;

COMMIT;
