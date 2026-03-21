-- ============================================================================
-- Migration 037: Add org_id to documents table + RLS (GA-008)
-- ============================================================================
-- Adds org_id to documents so RAG queries are tenant-scoped.
-- Enforces RLS matching the pattern used by other tenant tables.
-- ============================================================================

-- 1. Add column (idempotent)
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

-- 2. Back-fill via knowledge_bases (for existing rows)
UPDATE documents d
SET org_id = kb.org_id
FROM knowledge_bases kb
WHERE d.kb_id = kb.id
  AND d.org_id IS NULL;

-- 3. Enforce NOT NULL after filling
ALTER TABLE documents ALTER COLUMN org_id SET NOT NULL;

-- 4. Index for frequent queries
CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(org_id);

-- 5. Enable RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

-- 6. Isolation policy (idempotent)
DROP POLICY IF EXISTS documents_isolation ON documents;
CREATE POLICY documents_isolation ON documents
    FOR ALL
    TO govai_app
    USING (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
