-- Migration 089 — FASE 14.0 Etapa 2
-- =====================================================================
-- Kills the last vestige of the Arquiteto-workflow domain and renames
-- the delegation tables to match their real purpose (runtime):
--
--   1. Drop FK + NOT NULL + column architect_work_items.workflow_graph_id
--      (the pin that kept workflow_graphs alive as an orphan)
--   2. RENAME architect_work_items → runtime_work_items (data preserved)
--   3. RENAME architect_work_item_events → runtime_work_item_events
--   4. Renames any index / constraint still wearing the 'architect_*' prefix
--   5. DROP the four orphan workflow tables
--
-- Everything runs inside ONE transaction. If any step fails, none apply.
-- No "down migration": Etapa 2 is forward-only. In prod this would be
-- preceded by a pg_dump; in dev the stack is reproducible from seed.
-- =====================================================================

BEGIN;

-- ─── 1. Unpin architect_work_items.workflow_graph_id ───────────────────
--
-- Drop the FK constraint explicitly (recon confirmed the name). Then drop
-- NOT NULL (defensive — DROP COLUMN would succeed anyway). Then drop the
-- column itself. Any index that references the column gets killed by the
-- column drop; we handle the standalone index separately below for
-- clarity.

ALTER TABLE architect_work_items
    DROP CONSTRAINT IF EXISTS architect_work_items_workflow_graph_id_fkey;

-- Kill the composite index on (workflow_graph_id, status) — won't make
-- sense after the column is gone.
DROP INDEX IF EXISTS idx_work_items_graph;

ALTER TABLE architect_work_items
    ALTER COLUMN workflow_graph_id DROP NOT NULL;

ALTER TABLE architect_work_items
    DROP COLUMN workflow_graph_id;

-- ─── 2. Rename tables (atomic, preserves all data) ────────────────────
--
-- ALTER TABLE ... RENAME TO is an O(1) catalog update. Rows, indexes,
-- FK constraints (name-wise) and RLS policies move unchanged.

ALTER TABLE architect_work_items       RENAME TO runtime_work_items;
ALTER TABLE architect_work_item_events RENAME TO runtime_work_item_events;

-- ─── 3. Rename indexes that kept the 'architect_*' prefix ─────────────
--
-- Postgres carries the old names over on ALTER RENAME. Cosmetic, but
-- makes \d+ output readable and stops future grep-confirmatório from
-- hitting stale names.

DO $$
DECLARE
    r RECORD;
    new_name TEXT;
BEGIN
    FOR r IN
        SELECT indexname
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND (indexname LIKE 'architect_work_item%'
                OR indexname LIKE 'idx_architect_work_item%')
    LOOP
        new_name := replace(r.indexname, 'architect_work_item', 'runtime_work_item');
        EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, new_name);
        RAISE NOTICE 'Renamed index % → %', r.indexname, new_name;
    END LOOP;
END $$;

-- ─── 4. Rename constraints with the 'architect_*' prefix ──────────────
--
-- Each CHECK / FK / PK carries the old name even after the table rename.
-- We rename via ALTER TABLE ... RENAME CONSTRAINT so pg_dump output stays
-- readable and audit logs don't show anachronistic names.

DO $$
DECLARE
    r RECORD;
    new_name TEXT;
BEGIN
    FOR r IN
        SELECT c.conname, c.conrelid::regclass::text AS table_name
          FROM pg_constraint c
         WHERE c.conrelid IN (
                'runtime_work_items'::regclass,
                'runtime_work_item_events'::regclass
           )
           AND c.conname LIKE 'architect_%'
    LOOP
        new_name := replace(r.conname, 'architect_', 'runtime_');
        EXECUTE format(
            'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
            r.table_name, r.conname, new_name
        );
        RAISE NOTICE 'Renamed constraint % on % → %', r.conname, r.table_name, new_name;
    END LOOP;
END $$;

-- ─── 5. Drop the four orphan workflow tables ───────────────────────────
--
-- Order: leaves first (workflow_graphs), then roots (demand_cases). Each
-- DROP ... CASCADE also kills any triggers / policies / dependent views
-- still attached. After Etapa 1 scrubbed the code, no query references
-- these names, so nothing outside the DB notices.

DROP TABLE IF EXISTS workflow_graphs CASCADE;
DROP TABLE IF EXISTS architecture_decision_sets CASCADE;
DROP TABLE IF EXISTS problem_contracts CASCADE;
DROP TABLE IF EXISTS demand_cases CASCADE;

-- ─── 6. Sanity checks — fail loud if any step went wrong ──────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'runtime_work_items') THEN
        RAISE EXCEPTION 'runtime_work_items does not exist — rename failed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'runtime_work_item_events') THEN
        RAISE EXCEPTION 'runtime_work_item_events does not exist — rename failed';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'architect_work_items') THEN
        RAISE EXCEPTION 'architect_work_items still exists — rename did not land';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables
                WHERE tablename IN ('workflow_graphs', 'demand_cases',
                                    'problem_contracts', 'architecture_decision_sets')) THEN
        RAISE EXCEPTION 'An orphan workflow table survived the DROP';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'runtime_work_items'
           AND column_name = 'workflow_graph_id'
    ) THEN
        RAISE EXCEPTION 'workflow_graph_id column still on runtime_work_items';
    END IF;

    RAISE NOTICE 'Migration 089 OK: rename + orphan drop complete';
END $$;

COMMIT;
