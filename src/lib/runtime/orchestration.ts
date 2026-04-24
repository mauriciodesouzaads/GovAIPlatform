/**
 * Runtime — orchestration module
 * ---------------------------------------------------------------------------
 * Responsibility: decide WHETHER to delegate an assistant's message
 * to an autonomous work item, and WHICH runtime to hand it to. Pure
 * functions + metadata lookups; no side effects on running pipelines.
 *
 * Source of truth: `../runtime-delegation.ts` (renamed from
 * the legacy delegation module in FASE 14.0/2). `getAutoDelegationWorkflowGraphId`
 * was removed in 14.0/2 along with the dropped FK column it
 * resolved.
 */

export {
    shouldDelegate,
    runtimeFromPrefix,
    type DelegationConfig,
    type DelegationDecision,
    type DispatchResult,
} from '../runtime-delegation';
