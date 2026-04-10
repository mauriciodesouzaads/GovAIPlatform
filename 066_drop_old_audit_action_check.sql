-- Migration: 066_drop_old_audit_action_check.sql
-- Remove the legacy audit_logs_action_check constraint (12 actions) that coexists
-- with the new audit_logs_partitioned_action_check (15 actions, added in 065).
-- While both exist, inserts of TOOL_CALL_* are rejected by the old constraint.

BEGIN;

-- Drop from parent table — propagates to existing partitions
ALTER TABLE audit_logs_partitioned
    DROP CONSTRAINT IF EXISTS audit_logs_action_check;

-- Belt-and-suspenders: drop directly from the demo-org partition
-- (psql reports an error if the constraint was already dropped via inheritance)
ALTER TABLE audit_logs_org_00000000_0000_0000_0000_000000000001
    DROP CONSTRAINT IF EXISTS audit_logs_action_check;

COMMIT;
