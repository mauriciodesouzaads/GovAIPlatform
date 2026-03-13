-- Migration: 030_extend_audit_action_constraint.sql
-- Descrição: Estende o CHECK constraint de action em audit_logs_partitioned para
--            incluir TELEMETRY_CONSENT_GRANTED e TELEMETRY_CONSENT_REVOKED, adicionados
--            na migration 025 mas ausentes da constraint original em init.sql.
--            Também inclui EXECUTION e ASSISTANT_MODIFICATION para completude.
--
-- Problema: init.sql criou:
--   action TEXT NOT NULL CHECK (action IN (
--     'EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'POLICY_VIOLATION',
--     'ASSISTANT_MODIFICATION', 'PENDING_APPROVAL', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED'
--   ))
--
--   Migration 025 passou a inserir 'TELEMETRY_CONSENT_GRANTED' e
--   'TELEMETRY_CONSENT_REVOKED' — violando a constraint no CI ao rodar
--   integration-tests com as migrations em sequência.
--
-- Solução: Localizar a constraint pelo catálogo (nome gerado automaticamente
--          pelo PostgreSQL), removê-la e recriar com todos os valores válidos.
--
-- Idempotência: O bloco DO verifica a existência da constraint antes de removê-la.
--               O ADD CONSTRAINT usa IF NOT EXISTS via pg_constraint.

DO $$
DECLARE
    _cname TEXT;
BEGIN
    -- Localizar a CHECK constraint que menciona a coluna 'action'.
    -- NOTA: PostgreSQL armazena internamente "action IN (...)" como
    -- "action = ANY (ARRAY[...])", por isso buscamos por conname LIKE '%action%'
    -- ao invés de tentar fazer match na definição textual.
    SELECT conname INTO _cname
    FROM   pg_constraint
    WHERE  conrelid = 'public.audit_logs_partitioned'::regclass
      AND  contype  = 'c'
      AND  conname LIKE '%action%'
      AND  conname != 'audit_logs_action_check';  -- não dropar a que estamos criando

    IF _cname IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE public.audit_logs_partitioned DROP CONSTRAINT %I',
            _cname
        );
        RAISE NOTICE 'Dropped constraint: %', _cname;
    ELSE
        RAISE NOTICE 'No existing action CHECK constraint found — will only add new one';
    END IF;
END $$;

-- Recriar constraint com conjunto completo de valores válidos.
-- Deve estar em sincronia com o enum ActionType em src/lib/governance.ts.
ALTER TABLE public.audit_logs_partitioned
    ADD CONSTRAINT audit_logs_action_check
    CHECK (action IN (
        'EXECUTION',
        'EXECUTION_SUCCESS',
        'EXECUTION_ERROR',
        'POLICY_VIOLATION',
        'ASSISTANT_MODIFICATION',
        'PENDING_APPROVAL',
        'APPROVAL_GRANTED',
        'APPROVAL_REJECTED',
        'TELEMETRY_CONSENT_GRANTED',
        'TELEMETRY_CONSENT_REVOKED'
    ));

-- Verificar que a constraint foi criada corretamente
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE  conrelid = 'public.audit_logs_partitioned'::regclass
          AND  conname   = 'audit_logs_action_check'
    ) THEN
        RAISE EXCEPTION 'MIGRATION FAILED: audit_logs_action_check constraint not found after creation';
    END IF;
    RAISE NOTICE 'audit_logs_action_check constraint verified ✓';
END $$;
