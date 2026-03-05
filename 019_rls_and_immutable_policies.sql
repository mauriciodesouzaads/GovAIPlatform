-- Migration 019: True RLS Enforcement, Immutable Policies, and Strict Audit Insertions

-- 1. Create limited application user (Critical 1: Real RLS Enforcement)
-- PostgreSQL superusers (like 'postgres') bypass RLS completely (BYPASSRLS).
-- We create a specific user for the Node.js application to connect with.
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'govai_app') THEN
-- ATENÇÃO: Execute este script substituindo GOVAI_APP_PASSWORD pela senha real
-- Exemplo: psql -v APP_PASS='senha_forte' -f 019_rls_and_immutable_policies.sql
-- e usar: WITH PASSWORD :'APP_PASS'
    CREATE USER govai_app WITH PASSWORD 'GOVAI_APP_PASSWORD_PLACEHOLDER';
-- Em produção, altere a senha imediatamente após a migration:
-- ALTER USER govai_app WITH PASSWORD 'sua_senha_forte_aqui';
  END IF;
END
$$;

-- Grant privileges to the app user on existing tables and sequences
GRANT CONNECT ON DATABASE govai TO govai_app;
GRANT USAGE ON SCHEMA public TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO govai_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO govai_app;

-- Ensure future tables also inherit these permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO govai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO govai_app;

-- 2. Audit Logs: RLS isolation for INSERT operations (Serious 10)
-- Prevent an org from maliciously inserting a log into another org's partition
-- by spoofing the x-org-id at the proxy/middleware level.
DROP POLICY IF EXISTS org_audit_insert_isolation ON audit_logs_partitioned;
CREATE POLICY org_audit_insert_isolation ON audit_logs_partitioned 
    FOR INSERT WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- 3. Immutability trigger for `policy_versions` (Critical 4)
-- Legal guarantee: governance policies cannot be retroactively altered, only superseded by new versions.
CREATE TRIGGER trg_immutable_policy_versions 
BEFORE UPDATE OR DELETE ON policy_versions 
FOR EACH ROW EXECUTE FUNCTION protect_audit_logs();

-- 4. Apply Default Change to Assistant Versions (Minor 12)
-- Force 'draft' as the default status, preventing accidental publication of unreviewed assistants.
ALTER TABLE assistant_versions ALTER COLUMN status SET DEFAULT 'draft';
