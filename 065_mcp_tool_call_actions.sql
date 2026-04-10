-- Migration 065: Add MCP tool call action types to audit constraint
BEGIN;

ALTER TABLE audit_logs_partitioned DROP CONSTRAINT IF EXISTS audit_logs_partitioned_action_check;
ALTER TABLE audit_logs_partitioned ADD CONSTRAINT audit_logs_partitioned_action_check
  CHECK (action IN (
    'EXECUTION',
    'EXECUTION_SUCCESS',
    'EXECUTION_ERROR',
    'POLICY_VIOLATION',
    'ASSISTANT_MODIFICATION',
    'PENDING_APPROVAL',
    'APPROVAL_GRANTED',
    'APPROVAL_REJECTED',
    'QUOTA_EXCEEDED',
    'TELEMETRY_CONSENT_GRANTED',
    'TELEMETRY_CONSENT_REVOKED',
    'EXIT_GOVERNED_PERIMETER',
    'TOOL_CALL_SUCCESS',
    'TOOL_CALL_BLOCKED',
    'TOOL_CALL_FAILED'
  ));

COMMIT;
