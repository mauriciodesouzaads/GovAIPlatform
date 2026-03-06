-- Migration: 021_fix_users_rls_for_login.sql
-- Descrição: Permite que o serviço de API localize o usuário pelo e-mail durante o login, 
-- mesmo antes do contexto de organização (org_id) ser estabelecido na sessão do banco.

BEGIN;

-- Remover a política restritiva anterior ou complementá-la
-- A política users_isolation_policy em 013 bloqueia tudo se app.current_org_id estiver vazio.

DROP POLICY IF EXISTS users_login_policy ON users;

CREATE POLICY users_login_policy ON users
    FOR ALL
    TO govai_app
    USING (
        -- Permite busca se o contexto de org ainda não foi definido (fase de login)
        nullif(current_setting('app.current_org_id', true), '') IS NULL
        OR 
        -- Ou se o registro pertence à org do contexto atual
        org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    );

-- Permitir busca de chaves de API durante a autenticação
DROP POLICY IF EXISTS api_keys_auth_policy ON api_keys;
CREATE POLICY api_keys_auth_policy ON api_keys
    FOR SELECT
    TO govai_app
    USING (
        nullif(current_setting('app.current_org_id', true), '') IS NULL
        OR 
        org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    );

COMMIT;

