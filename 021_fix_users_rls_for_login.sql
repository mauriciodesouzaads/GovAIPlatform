-- Migration: 021_fix_users_rls_for_login.sql
-- Descrição: Política de acesso à tabela users para o fluxo de login local.
--
-- NOTA DE SEGURANÇA (P-01):
--   A versão original desta migration criava policies com condição IS NULL
--   que permitiam leitura irrestrita de todos os usuários sem contexto de org.
--   Isso foi corrigido aqui (novos deploys) e em 028_create_user_lookup.sql
--   (deploys existentes, via DROP + CREATE no mesmo BEGIN/COMMIT).
--
-- Fluxo correto pós-P-01:
--   O endpoint de login consulta primeiro user_lookup (tabela pública sem RLS)
--   para obter o org_id, depois seta app.current_org_id, e só então consulta
--   users (com RLS ativo). Nenhuma policy com IS NULL é necessária.

BEGIN;

-- Policy para usuários: acesso somente dentro do contexto org ativo.
-- NÃO contém IS NULL — isolamento garantido em 100% das queries.
DROP POLICY IF EXISTS users_login_policy ON users;

CREATE POLICY users_login_policy ON users
    FOR ALL
    TO govai_app
    USING (
        org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    );

-- Policy para api_keys: acesso somente dentro do contexto org ativo.
-- requireApiKey consulta api_key_lookup (sem RLS) em vez de api_keys diretamente.
DROP POLICY IF EXISTS api_keys_auth_policy ON api_keys;
CREATE POLICY api_keys_auth_policy ON api_keys
    FOR SELECT
    TO govai_app
    USING (
        org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    );

COMMIT;
