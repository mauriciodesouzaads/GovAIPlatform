-- Migration: 028_create_user_lookup.sql
-- Elimina RLS Login Bypass — P-01
-- ===========================================================================
-- VULNERABILIDADE CORRIGIDA:
--   021_fix_users_rls_for_login.sql criou policies com condição IS NULL:
--     USING (nullif(current_setting('app.current_org_id', true), '') IS NULL OR ...)
--
--   Isso permite que QUALQUER conexão sem app.current_org_id leia todos os
--   usuários e chaves de API do sistema — vetor crítico de cross-tenant
--   data leakage durante o fluxo de login.
--
-- SOLUÇÃO:
--   1. Tabelas de lookup sem RLS para autenticação pré-contexto
--   2. Triggers SECURITY DEFINER mantém lookups em sincronia
--   3. Remove IS NULL das policies — isolamento 100% por org_id
-- ===========================================================================

BEGIN;

-- ── 1. user_lookup ────────────────────────────────────────────────────────────
-- Tabela PÚBLICA (sem RLS). Mapeia email → (user_id, org_id) para usuários locais.
-- O endpoint de login consulta esta tabela ANTES de setar app.current_org_id,
-- eliminando a necessidade do bypass IS NULL em users.
-- Restrições: somente leitura para govai_app — escrita via trigger SECURITY DEFINER.
CREATE TABLE IF NOT EXISTS user_lookup (
    email     TEXT    PRIMARY KEY,
    user_id   UUID    NOT NULL,
    org_id    UUID    NOT NULL
);

-- govai_app só lê — jamais escreve diretamente nesta tabela
GRANT SELECT ON user_lookup TO govai_app;

-- ── 2. api_key_lookup ─────────────────────────────────────────────────────────
-- Tabela PÚBLICA (sem RLS). Mapeia key_hash → (prefix, org_id, is_active).
-- requireApiKey consulta esta tabela em vez de api_keys, eliminando o IS NULL
-- em api_keys_auth_policy.
CREATE TABLE IF NOT EXISTS api_key_lookup (
    key_hash  TEXT    PRIMARY KEY,
    prefix    TEXT    NOT NULL,
    org_id    UUID    NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

GRANT SELECT ON api_key_lookup TO govai_app;

-- ── 3. Trigger: users → user_lookup ─────────────────────────────────────────
-- SECURITY DEFINER: executa com os privilégios do owner da função (superuser),
-- ignorando RLS quando escreve em user_lookup. search_path fixo evita injection.
CREATE OR REPLACE FUNCTION sync_user_lookup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- DELETE: remove a entrada do usuário excluído
    IF TG_OP = 'DELETE' THEN
        DELETE FROM user_lookup WHERE user_id = OLD.id;
        RETURN OLD;
    END IF;

    -- Apenas usuários com autenticação local entram no lookup.
    -- SSO (entra_id, okta) usa fluxo OIDC separado — não precisa deste bypass.
    IF NEW.sso_provider != 'local' THEN
        IF TG_OP = 'UPDATE' AND OLD.sso_provider = 'local' THEN
            -- Provider mudou de 'local' para SSO: remove entrada antiga
            DELETE FROM user_lookup WHERE user_id = OLD.id;
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE com mudança de email: remove entrada sob o email antigo
    IF TG_OP = 'UPDATE' AND OLD.email IS DISTINCT FROM NEW.email THEN
        DELETE FROM user_lookup WHERE email = OLD.email AND user_id = OLD.id;
    END IF;

    -- UPSERT: cria ou atualiza entrada para o email atual
    INSERT INTO user_lookup (email, user_id, org_id)
    VALUES (NEW.email, NEW.id, NEW.org_id)
    ON CONFLICT (email) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            org_id  = EXCLUDED.org_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_user_lookup   ON users;
DROP TRIGGER IF EXISTS trg_delete_user_lookup ON users;

CREATE TRIGGER trg_sync_user_lookup
AFTER INSERT OR UPDATE OF email, org_id, sso_provider ON users
FOR EACH ROW EXECUTE FUNCTION sync_user_lookup();

CREATE TRIGGER trg_delete_user_lookup
AFTER DELETE ON users
FOR EACH ROW EXECUTE FUNCTION sync_user_lookup();

-- ── 4. Trigger: api_keys → api_key_lookup ────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_api_key_lookup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM api_key_lookup WHERE key_hash = OLD.key_hash;
        RETURN OLD;
    END IF;

    INSERT INTO api_key_lookup (key_hash, prefix, org_id, is_active)
    VALUES (NEW.key_hash, NEW.prefix, NEW.org_id, NEW.is_active)
    ON CONFLICT (key_hash) DO UPDATE
        SET prefix    = EXCLUDED.prefix,
            org_id    = EXCLUDED.org_id,
            is_active = EXCLUDED.is_active;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_api_key_lookup    ON api_keys;
DROP TRIGGER IF EXISTS trg_delete_api_key_lookup  ON api_keys;

CREATE TRIGGER trg_sync_api_key_lookup
AFTER INSERT OR UPDATE OF prefix, org_id, is_active ON api_keys
FOR EACH ROW EXECUTE FUNCTION sync_api_key_lookup();

CREATE TRIGGER trg_delete_api_key_lookup
AFTER DELETE ON api_keys
FOR EACH ROW EXECUTE FUNCTION sync_api_key_lookup();

-- ── 5. Backfill dos dados existentes ─────────────────────────────────────────

INSERT INTO user_lookup (email, user_id, org_id)
SELECT email, id AS user_id, org_id
FROM   users
WHERE  sso_provider = 'local'
  AND  email IS NOT NULL
  AND  org_id IS NOT NULL
ON CONFLICT (email) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        org_id  = EXCLUDED.org_id;

INSERT INTO api_key_lookup (key_hash, prefix, org_id, is_active)
SELECT key_hash, prefix, org_id, is_active
FROM   api_keys
WHERE  key_hash IS NOT NULL
ON CONFLICT (key_hash) DO UPDATE
    SET prefix    = EXCLUDED.prefix,
        org_id    = EXCLUDED.org_id,
        is_active = EXCLUDED.is_active;

-- ── 6. Corrigir policies — remover IS NULL (P-01) ────────────────────────────
-- Com os lookup tables, não há mais necessidade do bypass IS NULL.
-- Qualquer query sem app.current_org_id setado retorna 0 rows — comportamento correto.

DROP POLICY IF EXISTS users_login_policy ON users;
CREATE POLICY users_login_policy ON users
    FOR ALL
    TO govai_app
    USING (
        org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    );

DROP POLICY IF EXISTS api_keys_auth_policy ON api_keys;
CREATE POLICY api_keys_auth_policy ON api_keys
    FOR SELECT
    TO govai_app
    USING (
        org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    );

COMMIT;
