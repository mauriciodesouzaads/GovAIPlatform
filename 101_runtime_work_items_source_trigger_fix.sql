-- Migration 101 — FASE 14.0/6c.B.2-fix
-- =====================================================================
-- Fix do trigger BEFORE INSERT em runtime_work_items
--
-- A migration 100 fez retrofit em batch dos 231 work_items existentes
-- usando padrões de title (reality-check-*, [livre] reality-check*,
-- 6aN test, etc). Mas a função do trigger
-- runtime_work_items_set_source_default só inspecionava
-- execution_context.source ou caía em 'admin' default. Resultado:
-- testes que rodam DEPOIS da migration 100 e não setam source explícito
-- (a maioria — só handleCodeTurn faz isso) vazam para 'admin' e poluem
-- a tab "Execuções Diretas" em /evidencias.
--
-- Recon confirmou 18 work_items vazados pós-deploy 6c.B.2:
--   reality-check-agent-mode*  : 6 items (pattern novo, não estava na 100)
--   [livre] reality-check*     : 6 items
--   6aN test                   : 6 items
--
-- Esta migration:
--   1. Substitui a função do trigger para replicar os patterns do
--      retrofit da 100 + reality-check-agent-mode (escapou na 100)
--   2. UPDATE retroativo dos 18 work_items que vazaram entre 100 e 101
--   3. Sanity inline garantindo zero leaks remanescentes
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Função do trigger atualizada — replica retrofit logic
--
-- IMPORTANTE: trigger preserva intent explícito do caller. Se NEW.source
-- vier setado (ex.: handleCodeTurn passa 'chat'), não sobrescreve.
-- Só age quando NEW.source IS NULL.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION runtime_work_items_set_source_default()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.source IS NULL THEN
        NEW.source := CASE
            -- 1.1 — execution_context.source explícito ganha prioridade
            -- (handleCodeTurn em /chat mode=code grava 'chat' direto;
            -- futuro SDK público vai gravar 'api')
            WHEN NEW.execution_context->>'source' IN ('chat', 'admin', 'api', 'test')
                THEN NEW.execution_context->>'source'

            -- 1.2 — Padrões de teste automatizado. Lista replicada do
            -- retrofit em batch da migration 100, com adição do
            -- 'reality-check-agent-mode%' que só apareceu nos testes
            -- recentes (test-execucoes-end-to-end gera esse prefix).
            --
            -- Note: 'reality-check-agent-mode%' é subconjunto de
            -- 'reality-check-%', mas listamos explicitamente p/ documentar
            -- a origem do padrão e para futuras inspeções via \df+ ficar
            -- claro qual teste gera qual entry.
            WHEN NEW.title LIKE 'reality-check-%'
              OR NEW.title LIKE '[livre] reality-check%'
              OR NEW.title LIKE 'reality-check-agent-mode%'
              OR NEW.title LIKE '6a%test%'
              OR NEW.title LIKE '6a%probe%'
              OR NEW.title LIKE 'smoke-%'
              OR NEW.title LIKE 'test --%'
            THEN 'test'

            -- 1.3 — Catch-all: tudo o mais é admin (manual via
            -- /execucoes/nova, /execucoes/livre não-test, registros
            -- antigos com execution_context.source malformado).
            ELSE 'admin'
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- O trigger trg_runtime_work_items_source_default já existe (migration
-- 100) e aponta para a função pelo nome — CREATE OR REPLACE FUNCTION
-- basta. Não recriamos o trigger.

-- ─────────────────────────────────────────────────────────────────────
-- 2. UPDATE retroativo — corrige work_items vazados entre 100 e 101
--
-- Filtro estrito: WHERE source='admin' AND <título com padrão de teste>.
-- Não toca rows legítimos como "Quem é o DPO" (admin manual) ou
-- "[livre] ola" (admin via /execucoes/livre sem prefix de teste).
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    fixed_count INT;
BEGIN
    UPDATE runtime_work_items
       SET source = 'test'
     WHERE source = 'admin'
       AND (title LIKE 'reality-check-%'
            OR title LIKE '[livre] reality-check%'
            OR title LIKE 'reality-check-agent-mode%'
            OR title LIKE '6a%test%'
            OR title LIKE '6a%probe%'
            OR title LIKE 'smoke-%'
            OR title LIKE 'test --%');
    GET DIAGNOSTICS fixed_count = ROW_COUNT;
    RAISE NOTICE 'Migration 101 — % work_items reclassificados de admin para test', fixed_count;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Sanity check inline — nenhum admin pode ter pattern de teste
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    leaked_count INT;
    distribution TEXT;
BEGIN
    SELECT COUNT(*) INTO leaked_count
      FROM runtime_work_items
     WHERE source = 'admin'
       AND (title LIKE 'reality-check-%'
            OR title LIKE '[livre] reality-check%'
            OR title LIKE 'reality-check-agent-mode%'
            OR title LIKE '6a%test%'
            OR title LIKE '6a%probe%'
            OR title LIKE 'smoke-%'
            OR title LIKE 'test --%');
    IF leaked_count > 0 THEN
        RAISE EXCEPTION 'Migration 101 fix incomplete: % items admin ainda casam patterns de teste', leaked_count;
    END IF;

    SELECT string_agg(source || '=' || n, ', ' ORDER BY n DESC) INTO distribution
      FROM (SELECT source, COUNT(*) AS n FROM runtime_work_items GROUP BY source) sub;
    RAISE NOTICE 'Migration 101 OK — distribution pós-fix: %', distribution;
END $$;

COMMIT;
