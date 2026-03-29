-- Migration: 058_rls_nullif_remediation.sql
-- Adds nullif() to all pre-055 RLS policies that used
-- current_setting(...)::uuid directly, which throws on empty string.
-- Migration 055+ already uses the correct nullif pattern.
--
-- Policy names verified against live pg_policies on 2026-03-29.
-- Text-cast policies (billing_quotas, shield_network_*, token_usage_ledger)
-- are intentionally excluded: (col)::text = current_setting(...) is safe
-- because comparing text to '' matches nothing rather than throwing.

BEGIN;

-- api_keys
ALTER POLICY org_isolation_api_keys ON api_keys
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- assistant_publication_events
ALTER POLICY pub_events_isolation ON assistant_publication_events
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- assistants
ALTER POLICY org_isolation ON assistants
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- audit_logs_partitioned
ALTER POLICY org_audit_isolation ON audit_logs_partitioned
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- capability_runtime_bindings
ALTER POLICY runtime_binding_isolation ON capability_runtime_bindings
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- catalog_reviews
ALTER POLICY catalog_review_isolation ON catalog_reviews
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- documents
ALTER POLICY documents_isolation ON documents
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- evidence_links (subquery form)
ALTER POLICY evidence_links_isolation ON evidence_links
    USING (from_record_id IN (
        SELECT evidence_records.id
        FROM evidence_records
        WHERE evidence_records.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    ));

-- evidence_records
ALTER POLICY evidence_isolation ON evidence_records
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- knowledge_bases
ALTER POLICY org_isolation_knowledge ON knowledge_bases
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- org_hitl_keywords
ALTER POLICY org_hitl_keywords_isolation ON org_hitl_keywords
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- organizations (uses id = ... not org_id = ...)
ALTER POLICY org_isolation ON organizations
    USING (id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- pending_approvals
ALTER POLICY org_isolation_approvals ON pending_approvals
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- policy_exceptions
ALTER POLICY policy_exception_isolation ON policy_exceptions
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- policy_snapshots
ALTER POLICY policy_snapshot_isolation ON policy_snapshots
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

COMMIT;
