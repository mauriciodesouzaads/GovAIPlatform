BEGIN;

-- 1) Each SSO subject must be unique within its provider
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_identity_unique
    ON users (sso_provider, sso_user_id)
    WHERE sso_provider <> 'local' AND sso_user_id IS NOT NULL;

-- 2) Each organization maps to at most one SSO tenant id, and tenant ids are globally unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_sso_tenant_id_unique
    ON organizations (sso_tenant_id)
    WHERE sso_tenant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_sso_lookup_org_id_unique
    ON org_sso_lookup (org_id);

-- 3) Enforce documents.org_id == knowledge_bases.org_id at the database level
CREATE OR REPLACE FUNCTION ensure_document_kb_org_match()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    kb_org UUID;
BEGIN
    SELECT org_id INTO kb_org
    FROM knowledge_bases
    WHERE id = NEW.kb_id;

    IF kb_org IS NULL THEN
        RAISE EXCEPTION 'Knowledge base % not found for document insertion', NEW.kb_id;
    END IF;

    IF NEW.org_id IS DISTINCT FROM kb_org THEN
        RAISE EXCEPTION 'Document org_id % does not match knowledge base org_id %', NEW.org_id, kb_org;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_org_match ON documents;
CREATE TRIGGER trg_documents_org_match
BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION ensure_document_kb_org_match();

COMMIT;
