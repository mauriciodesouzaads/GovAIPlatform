/**
 * Architect — orchestration module (FASE 13.5b/1)
 * ---------------------------------------------------------------------------
 * Responsibility: decide WHETHER to delegate an assistant's message
 * to an autonomous work item, WHICH runtime/workflow to hand it to,
 * and WHAT payload to seed. Pure functions + metadata lookups; no
 * side effects on running pipelines.
 *
 * Source of truth currently lives in `../architect-delegation.ts`.
 * Re-exports here let callers target the organized namespace. Physical
 * code move scheduled for 13.5c.
 */

export {
    shouldDelegate,
    getAutoDelegationWorkflowGraphId,
    type DelegationConfig,
    type DelegationDecision,
    type DispatchResult,
} from '../architect-delegation';
