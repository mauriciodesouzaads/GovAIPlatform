-- ============================================================================
-- Migration 035: Organizations RLS (GA-002)
-- ============================================================================
-- Enables row-level security on the organizations table so that the
-- govai_app role can only read/write its own organization row.
-- platform_admin role has BYPASSRLS at the database level.
-- ============================================================================

-- Enable RLS on organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

-- Drop existing policy if re-running (idempotent)
DROP POLICY IF EXISTS org_isolation ON organizations;

-- Policy: govai_app sees only the org matching the current session setting
CREATE POLICY org_isolation ON organizations
    FOR ALL
    TO govai_app
    USING (id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (id = current_setting('app.current_org_id', true)::uuid);

-- Superuser and platform_admin bypass RLS automatically (BYPASSRLS privilege)
-- No additional policy needed for them.
