/**
 * Runtime — dispatch module
 * ---------------------------------------------------------------------------
 * Responsibility: execute orchestration decisions. Owns the adapter
 * functions (`runOpenClaudeAdapter`, `runInternalRagAdapter`, etc.) and
 * the top-level `dispatchWorkItem` entry point that the BullMQ worker
 * calls.
 *
 * BullMQ-level concerns (`handleTenantLimitRejection`, worker wiring)
 * live in `src/workers/runtime.worker.ts` — they depend on the Queue
 * instance that the worker module owns, so splitting them out would
 * create a cyclic import. That boundary stays.
 *
 * Source of truth: `../runtime-delegation.ts` (renamed from
 * the legacy delegation module in FASE 14.0/2). `dispatchPendingWorkItems` was
 * removed in 14.0/2 along with the dropped FK column it filtered
 * on — its only production caller (the workflow dispatch-all route)
 * was deleted in Etapa 1.
 */

export {
    runInternalRagAdapter,
    runHumanAdapter,
    runAgnoAdapter,
    runOpenClaudeAdapter,
    dispatchWorkItem,
    type AdapterResult,
    type RuntimeAdapterContext,
} from '../runtime-delegation';
