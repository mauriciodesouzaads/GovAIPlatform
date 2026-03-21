BEGIN;

-- 1) Platform admin role allowed at app schema level
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'platform_admin', 'sre', 'dpo', 'operator', 'auditor'));

-- 2) Production-safe local identity: local emails must be globally unique (case-insensitive)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM users
        WHERE sso_provider = 'local'
        GROUP BY LOWER(email)
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate local emails found across tenants. Resolve them before enabling production login isolation.';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_email_unique_ci
    ON users (LOWER(email))
    WHERE sso_provider = 'local';

-- 3) Normalize public login lookup to lowercase to make local login deterministic
DELETE FROM user_lookup;
INSERT INTO user_lookup (email, user_id, org_id)
SELECT LOWER(email), id, org_id
FROM users
WHERE sso_provider = 'local';

CREATE OR REPLACE FUNCTION sync_user_lookup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM user_lookup WHERE user_id = OLD.id;
        RETURN OLD;
    END IF;

    IF NEW.sso_provider != 'local' THEN
        IF TG_OP = 'UPDATE' AND OLD.sso_provider = 'local' THEN
            DELETE FROM user_lookup WHERE user_id = OLD.id;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND LOWER(OLD.email) IS DISTINCT FROM LOWER(NEW.email) THEN
        DELETE FROM user_lookup WHERE email = LOWER(OLD.email) AND user_id = OLD.id;
    END IF;

    INSERT INTO user_lookup (email, user_id, org_id)
    VALUES (LOWER(NEW.email), NEW.id, NEW.org_id)
    ON CONFLICT (email) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            org_id  = EXCLUDED.org_id;

    RETURN NEW;
END;
$$;

-- 4) Immutable publication event stores checklist evidence explicitly
ALTER TABLE assistant_publication_events
    ADD COLUMN IF NOT EXISTS checklist_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
