-- Migration: 027_add_key_rotation_tracking.sql
-- Descrição: Adiciona coluna de rastreamento de rotação de DEK em run_content_encrypted.
--
-- Contexto:
--   O Key Rotation Scheduler (src/jobs/key-rotation.job.ts) re-criptografa cada
--   registro de run_content_encrypted com uma nova DEK gerada a cada 90 dias.
--   Este processo garante forward secrecy — se uma DEK antiga for comprometida,
--   apenas dados anteriores à rotação estão em risco (janela limitada).
--
--   key_rotated_at = NULL indica que o registro nunca foi rotacionado (pré-scheduler).
--   Após a primeira rotação, o campo é atualizado com o timestamp da rotação.
--
-- Índice criado:
--   idx_run_content_rotation — permite o scheduler consultar eficientemente
--   os registros candidatos à rotação sem fazer seq scan na tabela inteira.

ALTER TABLE run_content_encrypted
    ADD COLUMN IF NOT EXISTS key_rotated_at TIMESTAMPTZ DEFAULT NULL;

-- Índice parcial: apenas registros não rotacionados ou com rotação antiga
-- são candidatos ao scheduler. Filtrar antecipadamente reduz o plano de execução.
CREATE INDEX IF NOT EXISTS idx_run_content_rotation
    ON run_content_encrypted (created_at, key_rotated_at)
    WHERE key_rotated_at IS NULL
       OR key_rotated_at < NOW() - INTERVAL '90 days';
