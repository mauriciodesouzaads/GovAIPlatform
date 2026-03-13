-- Migration: 024_create_platform_admin_role.sql
-- Descrição: Cria a role platform_admin com BYPASSRLS para uso exclusivo
-- pelo worker de expiração (cross-tenant) e operações SRE/DBA.
--
-- AVISO DE SEGURANÇA: Esta role bypassa todas as políticas RLS. Ela NÃO deve
-- ser concedida à role govai_app (role da aplicação). Apenas roles administrativas
-- e workers com contexto seguro devem assumir platform_admin.
--
-- NOTA: Era a migration migrations/021_create_platform_admin_role.sql, renumerada
-- para 024 para evitar conflito com 021_fix_users_rls_for_login.sql na raiz.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_admin') THEN
        EXECUTE 'CREATE ROLE platform_admin WITH BYPASSRLS NOLOGIN';
    END IF;
END
$$;

-- Concede platform_admin apenas ao superuser postgres — não ao current_user genérico.
-- Isso evita escalada de privilégio caso esta migration seja executada por outro usuário.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
        GRANT platform_admin TO postgres;
    END IF;
END
$$;
