/**
 * Architect — dispatch module (FASE 13.5b/1)
 * ---------------------------------------------------------------------------
 * Responsibility: execute orchestration decisions. Owns the adapter
 * functions (`runOpenClaudeAdapter`, `runInternalRagAdapter`, etc.),
 * the top-level `dispatchWorkItem` entry point that the BullMQ worker
 * calls, and the periodic `dispatchPendingWorkItems` sweep.
 *
 * BullMQ-level concerns (`handleTenantLimitRejection`, worker wiring)
 * live in `src/workers/architect.worker.ts` — they depend on the
 * Queue instance that the worker module owns, so splitting them out
 * would create a cyclic import. That boundary stays.
 *
 * Source of truth: `../architect-delegation.ts`. Re-exports organized
 * here for the 13.5b/1 refactor surface; physical move in 13.5c.
 */

export {
    runInternalRagAdapter,
    runHumanAdapter,
    runAgnoAdapter,
    runOpenClaudeAdapter,
    dispatchWorkItem,
    dispatchPendingWorkItems,
    type AdapterResult,
    type RuntimeAdapterContext,
} from '../architect-delegation';
