-- Migration: 032_explicit_vector_dimension.sql
-- Descrição: Garante que a coluna embedding em documents tenha dimensão
--            explícita vector(768). Se atttypmod = -1 (sem dimensão),
--            altera para vector(768). Se já for 768, apenas RAISE NOTICE.
--
-- Contexto: init.sql já cria documents.embedding vector(768). Esta migration
--            é idempotente e cobre cenários onde a coluna foi criada sem
--            dimensão explícita em versões antigas.
--
-- Sincronia: EMBEDDING_DIMENSION em src/lib/embedding-config.ts = 768

DO $$
DECLARE
    _atttypmod INT;
BEGIN
    SELECT a.atttypmod INTO _atttypmod
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_type t ON a.atttypid = t.oid
    WHERE c.relname = 'documents'
      AND a.attname = 'embedding'
      AND t.typname = 'vector'
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF _atttypmod IS NULL THEN
        RAISE NOTICE 'documents.embedding not found — skipping';
        RETURN;
    END IF;

    IF _atttypmod = -1 OR _atttypmod = 0 THEN
        -- Sem dimensão explícita — alterar para vector(768)
        ALTER TABLE documents
            ALTER COLUMN embedding TYPE vector(768);
        RAISE NOTICE 'documents.embedding altered to vector(768)';
    ELSIF _atttypmod = 768 THEN
        RAISE NOTICE 'documents.embedding already vector(768) — no change';
    ELSE
        RAISE NOTICE 'documents.embedding has dimension % — manual review required', _atttypmod;
    END IF;
END $$;
