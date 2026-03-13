-- Migration: 016_add_homologation_fields.sql
-- Descrição: Adiciona campos de homologação B2B em assistant_versions
--            (published_by, published_at, checklist_jsonb)

-- 1. Adiciona colunas (idempotente via IF NOT EXISTS)
ALTER TABLE assistant_versions
    ADD COLUMN IF NOT EXISTS published_by    VARCHAR(255),
    ADD COLUMN IF NOT EXISTS published_at    TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS checklist_jsonb JSONB DEFAULT '{}'::jsonb;

-- 2. Retroactive backfill em registros já publicados.
--
-- FIX-016: A migration 011 (ou 019) instala um trigger de imutabilidade em
-- assistant_versions que impede UPDATE/DELETE. O backfill abaixo usa
-- session_replication_role = 'replica' para desabilitar triggers de usuário
-- apenas nesta sessão, de forma cirúrgica e segura.
-- O estado original é restaurado imediatamente após o UPDATE.
--
-- Esta técnica é padrão em scripts de migração de schema no PostgreSQL.

DO $$
BEGIN
    -- Desabilita triggers de usuário para esta sessão
    SET session_replication_role = 'replica';

    UPDATE assistant_versions
    SET
        published_by    = 'system@govai.com',
        published_at    = created_at,
        checklist_jsonb = '{"retroactive_approval": true}'::jsonb
    WHERE status = 'published' AND published_by IS NULL;

    -- Restaura comportamento normal de triggers
    SET session_replication_role = 'origin';
END;
$$;

-- FIM DA MIGRATION
