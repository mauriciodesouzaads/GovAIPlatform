-- Migration 100 — FASE 14.0/6c.B.2
-- =====================================================================
-- Classificação de origem (source) dos runtime_work_items
--
-- Hoje runtime_work_items.execution_context->>'source' é populado apenas
-- para mode=code originados em /chat (handleCodeTurn grava 'chat'). Os
-- demais work_items (testes automatizados, /execucoes/nova manual, API
-- externa) ficam sem classificação clara. Esse mix torna /evidencias
-- (rebrand de /execucoes) confuso para o operador, que precisa rastrear
-- conversas auditáveis ↔ chamadas administrativas ↔ regression tests
-- separadamente.
--
-- Esta migration:
--   1. Promove source para coluna top-level com CHECK enum
--   2. Faz retrofit dos 231 work_items existentes via padrões observados
--      em recon (BLOCO 0):
--        - chat   : execution_context->>'source' = 'chat'
--        - test   : title patterns (reality-check, 6aN test, smoke-, etc.)
--        - admin  : catch-all (default seguro)
--   3. Cria index composto (org_id, source, created_at DESC) para os
--      filtros das 3 sub-abas
--   4. Cria trigger BEFORE INSERT que infere source de execution_context
--      quando o caller esquece — defesa em profundidade, não substitui
--      o INSERT explícito em handleCodeTurn (chat-native.routes.ts).
--
-- Backward compat: novos INSERTs sem source continuam funcionando (o
-- trigger preenche). Endpoint /v1/admin/runtime/work-items aceita
-- ?source= como filtro opcional (default=todas as fontes).
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Adiciona coluna nullable (CHECK só ativa após retrofit completo)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE runtime_work_items
    ADD COLUMN IF NOT EXISTS source TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Retrofit baseado nos padrões observados em produção (231 rows)
-- ─────────────────────────────────────────────────────────────────────
-- Ordem de avaliação importa: chat ganha sobre test (caso o usuário
-- digite "reality-check-foo" no /chat), test ganha sobre catch-all admin.
UPDATE runtime_work_items
   SET source = CASE
       -- 2.1 — Modo Code originado no /chat (handleCodeTurn)
       WHEN execution_context->>'source' = 'chat' THEN 'chat'

       -- 2.2 — Padrões de teste automatizado (suítes em
       -- tests/integration/*.sh + smoke scripts + 6a/6aN probes).
       -- Capturamos prefixo [livre] do /execucoes/livre porque esses
       -- títulos vêm de scripts: "[livre] reality-check-freeform-…".
       WHEN title LIKE 'reality-check-%'
         OR title LIKE '[livre] reality-check%'
         OR title LIKE '6a%test%'
         OR title LIKE '6a%probe%'
         OR title LIKE 'smoke-%'
         OR title LIKE 'test --%'
       THEN 'test'

       -- 2.3 — API externa (clientes via SDK), quando explicitamente
       -- marcado. Nenhum row hoje cai aqui mas o branch fica para o
       -- futuro próximo (FASE 15 SDK público).
       WHEN execution_context->>'source' = 'api' THEN 'api'

       -- 2.4 — Catch-all: tudo o mais é classificado como admin
       -- (operador via /execucoes/nova ou /execucoes/livre não-test,
       -- ou registros antigos com source malformado tipo URL path).
       ELSE 'admin'
   END
 WHERE source IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 3. NOT NULL após retrofit + CHECK enum-like
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE runtime_work_items
    ALTER COLUMN source SET NOT NULL;

ALTER TABLE runtime_work_items
    DROP CONSTRAINT IF EXISTS runtime_work_items_source_check;
ALTER TABLE runtime_work_items
    ADD CONSTRAINT runtime_work_items_source_check
    CHECK (source IN ('chat', 'admin', 'api', 'test'));

-- ─────────────────────────────────────────────────────────────────────
-- 4. Index composto para listagens das 3 sub-abas (org_id + source +
--    ORDER BY created_at DESC). Um único index cobre as 4 queries
--    {chat, admin, api, test} × org_id em ms.
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_runtime_work_items_source_created
    ON runtime_work_items (org_id, source, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 5. Trigger BEFORE INSERT — defesa em profundidade
--
-- Mesmo que adicionemos source explícito em handleCodeTurn (CP1.2),
-- callers legados (5b.2 /execucoes/nova, /execucoes/livre, futuro SDK)
-- ainda inserem sem source. O trigger infere de execution_context.source
-- ou usa 'admin' como default seguro.
--
-- IMPORTANTE: o trigger NÃO sobrescreve um source válido vindo do
-- INSERT — só age quando NEW.source IS NULL. Isso preserva a intenção
-- explícita do caller (ex.: handleCodeTurn força 'chat').
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION runtime_work_items_set_source_default()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.source IS NULL THEN
        NEW.source := CASE
            WHEN NEW.execution_context->>'source' IN ('chat', 'admin', 'api', 'test')
                THEN NEW.execution_context->>'source'
            ELSE 'admin'
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_runtime_work_items_source_default ON runtime_work_items;
CREATE TRIGGER trg_runtime_work_items_source_default
    BEFORE INSERT ON runtime_work_items
    FOR EACH ROW
    EXECUTE FUNCTION runtime_work_items_set_source_default();

-- ─────────────────────────────────────────────────────────────────────
-- 6. Comentários documentando o contrato
-- ─────────────────────────────────────────────────────────────────────
COMMENT ON COLUMN runtime_work_items.source IS
    'Origem do work_item — drives o filtro das 3 sub-abas em /evidencias. '
    'chat = originado em /chat mode=code (handleCodeTurn). '
    'admin = via /execucoes/nova, /execucoes/livre ou painel administrativo. '
    'api = via SDK público (FASE 15). '
    'test = suítes de regressão (tests/integration/*.sh).';

-- ─────────────────────────────────────────────────────────────────────
-- 7. Smoke check inline (RAISE se algo bizarro)
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    null_count INT;
    distribution TEXT;
BEGIN
    SELECT COUNT(*) INTO null_count FROM runtime_work_items WHERE source IS NULL;
    IF null_count > 0 THEN
        RAISE EXCEPTION 'Migration 100 retrofit incomplete: % rows with NULL source', null_count;
    END IF;

    SELECT string_agg(source || '=' || n, ', ' ORDER BY n DESC) INTO distribution
      FROM (SELECT source, COUNT(*) AS n FROM runtime_work_items GROUP BY source) sub;
    RAISE NOTICE 'Migration 100 OK — distribution: %', distribution;
END $$;

COMMIT;
