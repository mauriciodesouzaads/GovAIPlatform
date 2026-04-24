/**
 * Runtime — governance module
 * ---------------------------------------------------------------------------
 * Responsibility: enforcement gates and audit event emission on the
 * runtime execution pipeline. Tool classification, approval decisions,
 * work-item event writes, watchdog recoveries.
 *
 * Source of truth: `../runtime-delegation.ts` (renamed from
 * the legacy delegation module in FASE 14.0/2).
 */

export {
    resolveToolDecision,
    insertWorkItemEvent,
    detectAndMarkStuckWorkItems,
    recoverOrphanedPendingWorkItems,
    type ToolDecision,
} from '../runtime-delegation';
