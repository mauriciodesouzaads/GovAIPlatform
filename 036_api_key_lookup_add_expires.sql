-- ============================================================================
-- Migration 036: Add expires_at to api_key_lookup (GA-004)
-- ============================================================================
-- Extends the api_key_lookup table with an expires_at column so that
-- requireApiKey can enforce expiry without bypassing RLS on api_keys.
-- A trigger keeps api_key_lookup.expires_at in sync with api_keys.expires_at.
-- ============================================================================

-- 1. Add column (idempotent)
ALTER TABLE api_key_lookup
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 2. Back-fill from api_keys (for existing rows)
UPDATE api_key_lookup akl
SET expires_at = ak.expires_at
FROM api_keys ak
WHERE akl.key_hash = ak.key_hash
  AND akl.expires_at IS DISTINCT FROM ak.expires_at;

-- 3. Sync trigger: keeps lookup in sync when api_keys is updated
CREATE OR REPLACE FUNCTION sync_api_key_lookup_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE api_key_lookup
    SET expires_at = NEW.expires_at,
        is_active  = NEW.is_active
    WHERE key_hash = NEW.key_hash;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_api_key_expiry ON api_keys;
CREATE TRIGGER trg_sync_api_key_expiry
    AFTER UPDATE OF expires_at, is_active ON api_keys
    FOR EACH ROW
    EXECUTE FUNCTION sync_api_key_lookup_expiry();
