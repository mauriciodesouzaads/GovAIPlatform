-- Migration: 025_add_telemetry_consent.sql
-- Descrição: Adiciona controle de consentimento de telemetria por organização.
--
-- LGPD / GDPR: O worker de telemetria envia prompts e completions para o
-- Langfuse (serviço externo de observabilidade). Isso constitui transferência
-- de dados pessoais para terceiros e requer consentimento explícito do titular.
--
-- Por padrão, telemetria_externa está DESABILITADA (opt-in).
-- O admin de cada tenant pode habilitá-la via painel após aceitar os termos.
--
-- Campos:
--   telemetry_consent        - consentimento geral de telemetria externa
--   telemetry_consent_at     - timestamp do consentimento
--   telemetry_consent_by     - user_id do admin que concedeu o consentimento
--   telemetry_pii_strip      - se TRUE, envia apenas métricas agregadas (tokens/custo/latência)
--                              sem prompt ou completion

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS telemetry_consent     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS telemetry_consent_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS telemetry_consent_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS telemetry_pii_strip   BOOLEAN NOT NULL DEFAULT TRUE;

-- Índice para queries frequentes no worker
CREATE INDEX IF NOT EXISTS idx_organizations_telemetry_consent
    ON organizations (id)
    WHERE telemetry_consent = TRUE;

COMMENT ON COLUMN organizations.telemetry_consent IS
    'Consentimento explícito para envio de telemetria ao Langfuse (opt-in). LGPD Art. 7, I.';
COMMENT ON COLUMN organizations.telemetry_pii_strip IS
    'Se TRUE, envia apenas métricas agregadas para o Langfuse — sem prompt ou completion.';
