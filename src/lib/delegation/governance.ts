/**
 * Architect — governance module (FASE 13.5b/1)
 * ---------------------------------------------------------------------------
 * Responsibility: enforcement gates and audit event emission on the
 * architect execution pipeline. Tool classification, approval decisions,
 * work-item event writes, watchdog recoveries.
 *
 * Source of truth for these exports currently lives in
 * `../architect-delegation.ts` (1500+ lines legacy monolith). This
 * module re-exports the governance surface so new call sites can depend
 * on the organized namespace without waiting for the full physical
 * move, which is scheduled for 13.5c.
 *
 * Do not add new logic here. Add it in the legacy file until the move
 * is done; the re-exports are guaranteed to pick it up.
 */

export {
    resolveToolDecision,
    insertWorkItemEvent,
    detectAndMarkStuckWorkItems,
    recoverOrphanedPendingWorkItems,
    type ToolDecision,
} from '../architect-delegation';
