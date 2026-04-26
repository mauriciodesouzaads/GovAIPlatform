-- Migration 094 — FASE 14.0/6a₁
-- =====================================================================
-- RAG real com Qdrant. Estende as tabelas legadas (knowledge_bases +
-- documents do init.sql) com metadata para o pipeline novo
-- (extraction → chunking → embedding → upsert no Qdrant) e cria três
-- tabelas auxiliares: document_chunks (metadata por chunk; vetor real
-- mora no Qdrant), assistant_knowledge_bases (link many-to-many) e
-- retrieval_log (auditoria de cada retrieval).
--
-- Por que ALTER e não DROP/CREATE
-- -------------------------------
-- O pipeline RAG legacy (src/lib/rag.ts + execution.service.ts +
-- approvals.routes.ts) usa knowledge_bases + documents.embedding via
-- pgvector HNSW para enriquecer chamadas /v1/execute (caminho
-- LLM-direto, antes de chegar ao runner). Esse caminho continua vivo
-- nesta etapa — não há razão para quebrar /v1/execute por causa do
-- novo pipeline de runner. Os caminhos coexistem; em 6a₂/6b
-- consolidamos.
--
-- Consequência: knowledge_bases ganha colunas para descrever a
-- collection no Qdrant + contadores; documents ganha extraction_status,
-- sha256, storage_path, dlp_scan_result e demais campos. Linhas
-- existentes (4 KBs no demo, 0 documents) recebem defaults seguros e
-- a migration não invalida-as.
-- =====================================================================

BEGIN;

-- ─── 1. knowledge_bases — extensão para o pipeline Qdrant ────────────
ALTER TABLE knowledge_bases
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS embedding_provider TEXT NOT NULL DEFAULT 'gemini',
    ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'gemini-embedding-001',
    ADD COLUMN IF NOT EXISTS embedding_dim INT NOT NULL DEFAULT 768,
    ADD COLUMN IF NOT EXISTS chunk_size_tokens INT NOT NULL DEFAULT 512,
    ADD COLUMN IF NOT EXISTS chunk_overlap_tokens INT NOT NULL DEFAULT 64,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS qdrant_collection_name TEXT,
    ADD COLUMN IF NOT EXISTS document_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chunk_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_size_bytes BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE knowledge_bases
    DROP CONSTRAINT IF EXISTS knowledge_bases_status_check;
ALTER TABLE knowledge_bases
    ADD CONSTRAINT knowledge_bases_status_check
    CHECK (status IN ('active', 'archived', 'building'));

-- Backfill qdrant_collection_name para linhas legacy (4 KBs demo).
-- Format: govai_org_<uuid_compact>_<kb_uuid_compact>. Permite múltiplas
-- KBs por org sem colisão e mantém o prefixo previsível para o lib.
UPDATE knowledge_bases
   SET qdrant_collection_name =
       'govai_org_' || replace(org_id::text, '-', '') ||
       '_' || replace(id::text, '-', '')
 WHERE qdrant_collection_name IS NULL;

ALTER TABLE knowledge_bases
    ALTER COLUMN qdrant_collection_name SET NOT NULL;

-- Trigger para manter updated_at fresco em UPDATEs.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_kb_updated_at'
    ) THEN
        CREATE OR REPLACE FUNCTION update_kb_updated_at()
            RETURNS TRIGGER LANGUAGE plpgsql AS
        $body$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $body$;
        CREATE TRIGGER trg_kb_updated_at
            BEFORE UPDATE ON knowledge_bases
            FOR EACH ROW EXECUTE FUNCTION update_kb_updated_at();
    END IF;
END $$;

-- Index on status for the catalog list view.
CREATE INDEX IF NOT EXISTS idx_kb_org_status
    ON knowledge_bases(org_id, status);

-- knowledge_bases já tem RLS policy org_isolation_knowledge desde
-- init.sql; só garantimos que está ENABLE + FORCE.
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_bases FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_bases TO govai_app;

-- ─── 2. documents — extensão para o pipeline novo ────────────────────
-- Mantemos as colunas legadas (kb_id, content, embedding) intactas para
-- o pipeline /v1/execute continuar funcionando. As novas colunas só
-- entram em uso quando o documento é enviado pelo endpoint de upload
-- (POST /v1/admin/knowledge-bases/:id/documents).
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS knowledge_base_id UUID,
    ADD COLUMN IF NOT EXISTS filename TEXT,
    ADD COLUMN IF NOT EXISTS mime_type TEXT,
    ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
    ADD COLUMN IF NOT EXISTS sha256 TEXT,
    ADD COLUMN IF NOT EXISTS storage_path TEXT,
    ADD COLUMN IF NOT EXISTS extraction_status TEXT NOT NULL DEFAULT 'ready',
    ADD COLUMN IF NOT EXISTS extraction_error TEXT,
    ADD COLUMN IF NOT EXISTS page_count INT,
    ADD COLUMN IF NOT EXISTS extracted_text_chars INT,
    ADD COLUMN IF NOT EXISTS chunk_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dlp_scan_result JSONB,
    ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill knowledge_base_id from kb_id for legacy rows (today: 0).
UPDATE documents SET knowledge_base_id = kb_id WHERE knowledge_base_id IS NULL;

-- FK + CHECK on the new column (after backfill so existing data validates).
ALTER TABLE documents
    DROP CONSTRAINT IF EXISTS documents_knowledge_base_id_fkey;
ALTER TABLE documents
    ADD CONSTRAINT documents_knowledge_base_id_fkey
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE;

ALTER TABLE documents
    DROP CONSTRAINT IF EXISTS documents_extraction_status_check;
ALTER TABLE documents
    ADD CONSTRAINT documents_extraction_status_check
    CHECK (extraction_status IN ('pending', 'extracting', 'chunking',
                                  'embedding', 'ready', 'failed'));

-- (knowledge_base_id, sha256) UNIQUE so re-uploading the same file is
-- idempotent within a KB. Allow legacy rows without sha256 to coexist
-- by making the constraint partial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_kb_sha256
    ON documents(knowledge_base_id, sha256)
    WHERE sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_extraction_status
    ON documents(extraction_status)
    WHERE extraction_status <> 'ready';

-- documents já tem RLS forced + policy desde init.sql; nada a mudar.
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO govai_app;

-- ─── 3. document_chunks — metadata por chunk (vetor mora no Qdrant) ──
CREATE TABLE IF NOT EXISTS document_chunks (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    chunk_index       INT  NOT NULL,
    page_number       INT,
    content_preview   TEXT,            -- primeiros 200 chars (UI render)
    content_hash      TEXT NOT NULL,   -- sha256 do conteúdo do chunk
    token_count       INT,
    qdrant_point_id   UUID NOT NULL,   -- = id desta linha (mesma uuid)
    metadata          JSONB DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc
    ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_kb
    ON document_chunks(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_org
    ON document_chunks(org_id);

ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_chunks_isolation ON document_chunks;
CREATE POLICY document_chunks_isolation ON document_chunks
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON document_chunks TO govai_app;

-- ─── 4. assistant_knowledge_bases — link many-to-many ────────────────
-- Substitui o legacy knowledge_bases.assistant_id (1:1) sem removê-lo.
-- Um agente pode ter várias KBs (priority decide ordem em retrieval com
-- múltiplas), e uma KB pode servir vários agentes (catálogo de
-- compliance reaproveitado entre 'Análise de Crédito', 'Jurídico' etc).
CREATE TABLE IF NOT EXISTS assistant_knowledge_bases (
    assistant_id        UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    knowledge_base_id   UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    priority            INT  NOT NULL DEFAULT 100,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    retrieval_top_k     INT,             -- override
    retrieval_min_score NUMERIC(3,2),    -- override
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (assistant_id, knowledge_base_id)
);

CREATE INDEX IF NOT EXISTS idx_akb_assistant ON assistant_knowledge_bases(assistant_id);
CREATE INDEX IF NOT EXISTS idx_akb_kb        ON assistant_knowledge_bases(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_akb_org       ON assistant_knowledge_bases(org_id);

ALTER TABLE assistant_knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_knowledge_bases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS akb_isolation ON assistant_knowledge_bases;
CREATE POLICY akb_isolation ON assistant_knowledge_bases
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_knowledge_bases TO govai_app;

-- ─── 5. retrieval_log — auditoria de retrievals ──────────────────────
CREATE TABLE IF NOT EXISTS retrieval_log (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id            UUID NOT NULL,
    work_item_id      UUID,
    assistant_id      UUID,
    knowledge_base_id UUID,
    query_preview     TEXT,           -- primeiros 200 chars da query
    chunks_retrieved  INT NOT NULL,
    top_score         NUMERIC(5,4),
    latency_ms        INT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retrieval_log_org
    ON retrieval_log(org_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_log_wi
    ON retrieval_log(work_item_id)
    WHERE work_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_retrieval_log_created
    ON retrieval_log(created_at DESC);

-- retrieval_log é cross-tenant para o admin agregar; RLS opcional.
-- Para simplicidade, isolamos em queries application-side via WHERE
-- org_id = $1 (nenhum endpoint expõe retrieval_log sem orgId).
ALTER TABLE retrieval_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS retrieval_log_isolation ON retrieval_log;
CREATE POLICY retrieval_log_isolation ON retrieval_log
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT ON retrieval_log TO govai_app;

-- ─── 6. Sanity checks ────────────────────────────────────────────────
DO $$
DECLARE
    kb_extended INT;
    docs_extended INT;
BEGIN
    SELECT COUNT(*) INTO kb_extended
      FROM information_schema.columns
     WHERE table_name = 'knowledge_bases'
       AND column_name IN ('embedding_provider', 'qdrant_collection_name',
                           'document_count', 'chunk_count', 'status');
    IF kb_extended < 5 THEN
        RAISE EXCEPTION 'knowledge_bases extension incomplete (got %, need 5)', kb_extended;
    END IF;

    SELECT COUNT(*) INTO docs_extended
      FROM information_schema.columns
     WHERE table_name = 'documents'
       AND column_name IN ('extraction_status', 'sha256', 'storage_path',
                           'dlp_scan_result', 'knowledge_base_id');
    IF docs_extended < 5 THEN
        RAISE EXCEPTION 'documents extension incomplete (got %, need 5)', docs_extended;
    END IF;

    -- Three new tables exist
    PERFORM 1 FROM information_schema.tables WHERE table_name = 'document_chunks';
    IF NOT FOUND THEN RAISE EXCEPTION 'document_chunks not created'; END IF;
    PERFORM 1 FROM information_schema.tables WHERE table_name = 'assistant_knowledge_bases';
    IF NOT FOUND THEN RAISE EXCEPTION 'assistant_knowledge_bases not created'; END IF;
    PERFORM 1 FROM information_schema.tables WHERE table_name = 'retrieval_log';
    IF NOT FOUND THEN RAISE EXCEPTION 'retrieval_log not created'; END IF;

    RAISE NOTICE 'Migration 094 OK — RAG schema extended';
END $$;

COMMIT;
