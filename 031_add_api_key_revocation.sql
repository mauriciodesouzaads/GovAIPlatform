-- Migration: 031_add_api_key_revocation.sql
-- Descrição: Adiciona colunas de auditoria de revogação em api_keys.
--
-- Contexto: A tabela api_keys original (init.sql) tinha apenas is_active para
-- desativar chaves. Para suportar rastreabilidade de revogação (ex: chave
-- exposta em git, chave comprometida, expiração manual), adicionamos:
--   - revoke_reason TEXT  — motivo estruturado da revogação (auditável)
--   - revoked_at    TIMESTAMPTZ — timestamp exato da revogação
--
-- Idempotência: IF NOT EXISTS em ambas as colunas.

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS revoke_reason TEXT,
    ADD COLUMN IF NOT EXISTS revoked_at    TIMESTAMPTZ;

-- Índice parcial: facilita auditoria de chaves revogadas por motivo
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked
    ON api_keys (org_id, revoked_at)
    WHERE is_active = false;

-- Verificar que as colunas foram criadas
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE  table_name   = 'api_keys'
          AND  column_name  = 'revoke_reason'
    ) THEN
        RAISE EXCEPTION 'MIGRATION FAILED: revoke_reason column not found in api_keys';
    END IF;
    RAISE NOTICE 'api_keys.revoke_reason ✓';
    RAISE NOTICE 'api_keys.revoked_at ✓';
END $$;
