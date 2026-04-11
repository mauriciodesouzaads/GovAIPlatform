-- Migration: 066_drop_old_audit_action_check.sql
-- Remove the legacy audit_logs_action_check constraint (12 actions) that coexists
-- with the new audit_logs_partitioned_action_check (15 actions, added in 065).
-- While both exist, inserts of TOOL_CALL_* are rejected by the old constraint.

BEGIN;

-- Drop from parent table — propagates to existing partitions
ALTER TABLE audit_logs_partitioned
    DROP CONSTRAINT IF EXISTS audit_logs_action_check;

-- Belt-and-suspenders: drop directly from the demo-org partition if it exists.
-- On a fresh DB the partition is created by seed.sql (after migrations), so
-- this is a no-op on first install — safe to skip with a DO block.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'audit_logs_org_00000000_0000_0000_0000_000000000001'
    ) THEN
        ALTER TABLE audit_logs_org_00000000_0000_0000_0000_000000000001
            DROP CONSTRAINT IF EXISTS audit_logs_action_check;
    END IF;
END;
$$;

COMMIT;
