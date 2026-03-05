-- Migration: 016_add_homologation_fields.sql
-- Descrição: Adiciona campos de homologação b2b em assistant_versions (published_by, published_at, checklist_jsonb)

-- 1. Addition of homologation fields to assistant_versions
ALTER TABLE assistant_versions
ADD COLUMN IF NOT EXISTS published_by VARCHAR(255),
ADD COLUMN IF NOT EXISTS published_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS checklist_jsonb JSONB DEFAULT '{}'::jsonb;

-- 2. Update existing published versions with dummy data to satisfy potential UI constraints
UPDATE assistant_versions
SET published_by = 'system@govai.com',
    published_at = created_at,
    checklist_jsonb = '{"retroactive_approval": true}'::jsonb
WHERE status = 'published' AND published_by IS NULL;

-- FIM DA MIGRATION
