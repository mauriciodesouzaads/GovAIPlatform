-- Migration: 063_review_tracks_customizable.sql
-- Objetivo: Adicionar suporte a soft-delete e ativação em review_tracks

BEGIN;

ALTER TABLE review_tracks ADD COLUMN IF NOT EXISTS is_active  BOOLEAN      NOT NULL DEFAULT true;
ALTER TABLE review_tracks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE review_tracks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP;

-- Índice parcial: unique só entre tracks ativos (deleted_at IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_tracks_unique_active
    ON review_tracks (org_id, name) WHERE deleted_at IS NULL;

COMMIT;
