-- Migration: 059_exit_perimeter_tracking.sql
-- Descrição: Adiciona 'EXIT_GOVERNED_PERIMETER' ao CHECK constraint da tabela
--            audit_logs_partitioned, suportando o registro de saída voluntária
--            do perímetro governado (Hard Clickwrap — FASE-A1).
--
-- Não cria novas tabelas. Reutiliza audit_logs_partitioned como trilha imutável.
-- Segue o mesmo padrão de migration 030_extend_audit_action_constraint.sql.

DO $$
DECLARE
    _cname TEXT;
BEGIN
    -- Localizar CHECK constraint existente que menciona a coluna 'action'
    SELECT conname INTO _cname
    FROM   pg_constraint
    WHERE  conrelid = 'public.audit_logs_partitioned'::regclass
      AND  contype  = 'c'
      AND  conname LIKE '%action%'
      AND  conname != 'audit_logs_action_check_v2';  -- não dropar a que estamos criando

    IF _cname IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE public.audit_logs_partitioned DROP CONSTRAINT %I',
            _cname
        );
        RAISE NOTICE 'Dropped existing action constraint: %', _cname;
    ELSE
        RAISE NOTICE 'No existing action CHECK constraint found — will only add new one';
    END IF;
END $$;

-- Recriar constraint incluindo EXIT_GOVERNED_PERIMETER.
-- Deve estar em sincronia com ActionType enum em src/lib/governance.ts.
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
        'QUOTA_EXCEEDED',
        'TELEMETRY_CONSENT_GRANTED',
        'TELEMETRY_CONSENT_REVOKED',
        'EXIT_GOVERNED_PERIMETER'
    ));

-- Verificação de integridade
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE  conrelid = 'public.audit_logs_partitioned'::regclass
          AND  conname   = 'audit_logs_action_check'
    ) THEN
        RAISE EXCEPTION 'MIGRATION FAILED: audit_logs_action_check constraint not found after creation';
    END IF;
    RAISE NOTICE 'audit_logs_action_check constraint verified ✓ (includes EXIT_GOVERNED_PERIMETER)';
END $$;
