BEGIN;

CREATE TABLE IF NOT EXISTS org_sso_lookup (
    sso_tenant_id TEXT PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
);

GRANT SELECT ON org_sso_lookup TO govai_app;

DELETE FROM org_sso_lookup;
INSERT INTO org_sso_lookup (sso_tenant_id, org_id)
SELECT sso_tenant_id, id
FROM organizations
WHERE sso_tenant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_org_sso_lookup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM org_sso_lookup WHERE org_id = OLD.id;
        RETURN OLD;
    END IF;

    DELETE FROM org_sso_lookup WHERE org_id = NEW.id;

    IF NEW.sso_tenant_id IS NOT NULL THEN
        INSERT INTO org_sso_lookup (sso_tenant_id, org_id)
        VALUES (NEW.sso_tenant_id, NEW.id)
        ON CONFLICT (sso_tenant_id) DO UPDATE SET org_id = EXCLUDED.org_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_org_sso_lookup ON organizations;
CREATE TRIGGER trg_sync_org_sso_lookup
AFTER INSERT OR UPDATE OR DELETE ON organizations
FOR EACH ROW EXECUTE FUNCTION sync_org_sso_lookup();

COMMIT;
