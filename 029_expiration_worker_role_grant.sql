-- Migration: 029_expiration_worker_role_grant.sql
-- P-02: Eliminar Cross-Tenant Expiration Worker — SET ROLE platform_admin
-- ===========================================================================
-- VULNERABILIDADE CORRIGIDA:
--   020_expiration_worker_rls_bypass.sql criou expiration_worker_policy sem
--   filtro de org_id:
--     USING (status = 'pending' AND expires_at <= NOW())
--   Isso permite que qualquer conexão com a policy ativa modifique
--   pending_approvals de TODOS os tenants sem contexto de org — mutação
--   cross-tenant irrestrita.
--
-- SOLUÇÃO:
--   1. Dropa expiration_worker_policy — isolamento RLS restaurado
--   2. GRANT platform_admin TO govai_app — habilita SET ROLE no worker
--
-- MODELO DE SEGURANÇA PÓS-P-02:
--   O expiration.worker.ts executa SET ROLE platform_admin imediatamente
--   antes do UPDATE e RESET ROLE em bloco finally — a janela de BYPASSRLS
--   é mínima, explícita e auditável em logs estruturados.
--
--   Diferença do modelo anterior:
--     Antes: qualquer conexão govai_app sem contexto passava pela policy
--            cross-tenant (implícito, silencioso, sem rastreabilidade).
--     Depois: apenas o expiration worker chama SET ROLE explicitamente,
--             o scope é uma única query UPDATE, e RESET ROLE é sempre
--             chamado no finally.
--
--   Tradeoff documentado: GRANT platform_admin TO govai_app significa que
--   qualquer código rodando como govai_app pode chamar SET ROLE. Isso é
--   aceitável porque:
--     (a) govai_app não tem BYPASSRLS diretamente — precisa de SET ROLE
--     (b) SET ROLE aparece em logs de query (pg_stat_activity, pgaudit)
--     (c) A alternativa seria uma função SECURITY DEFINER, adicionando
--         complexidade sem ganho de segurança em nosso modelo de ameaça
-- ===========================================================================

BEGIN;

-- ── 1. Dropar a policy cross-tenant ──────────────────────────────────────────
-- expiration_worker_policy não filtrava org_id — permitia UPDATE em
-- pending_approvals de qualquer tenant sem set_config ativo.
DROP POLICY IF EXISTS expiration_worker_policy ON pending_approvals;

-- ── 2. Habilitar SET ROLE platform_admin para govai_app ──────────────────────
-- Permite que o expiration worker assuma platform_admin (BYPASSRLS) de forma
-- controlada. GRANT é idempotente — safe para re-aplicar.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'govai_app')
       AND EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_admin') THEN
        GRANT platform_admin TO govai_app;
    ELSE
        RAISE EXCEPTION
            'P-02 PREREQUISITE: roles govai_app e platform_admin devem existir '
            '(criadas em 019_rls_and_immutable_policies.sql e 024_create_platform_admin_role.sql).';
    END IF;
END
$$;

COMMIT;
