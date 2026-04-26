-- Migration 095 — FASE 14.0/6a₁ hotfix
-- =====================================================================
-- documents.kb_id (legacy FK from init.sql) blocked parent deletes
-- because it had no ON DELETE clause — DELETE on knowledge_bases would
-- fail with FK violation 23503 even though the new knowledge_base_id
-- column (added in 094) already cascaded.
--
-- Trace: 6a₁ reality-check left an orphan Qdrant collection because
-- the DELETE handler at /v1/admin/knowledge-bases/:id received a
-- DatabaseError before reaching dropCollection().
--
-- Fix: recreate documents.kb_id FK with ON DELETE CASCADE so both
-- columns (legacy and new) cascade consistently. We don't drop
-- kb_id — the legacy /v1/execute pipeline (src/lib/rag.ts +
-- execution.service.ts:570) still queries by kb_id, and dropping
-- the column would break that path. Two cascading FKs to the same
-- target is a no-op overhead in PostgreSQL — they don't double-cascade.
-- =====================================================================

BEGIN;

ALTER TABLE documents
    DROP CONSTRAINT IF EXISTS documents_kb_id_fkey;

ALTER TABLE documents
    ADD CONSTRAINT documents_kb_id_fkey
    FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE;

DO $$
BEGIN
    PERFORM 1
       FROM pg_constraint
      WHERE conname = 'documents_kb_id_fkey'
        AND confdeltype = 'c';  -- 'c' = CASCADE
    IF NOT FOUND THEN
        RAISE EXCEPTION 'documents_kb_id_fkey did not get ON DELETE CASCADE';
    END IF;
END $$;

COMMIT;
