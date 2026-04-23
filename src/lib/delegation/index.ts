/**
 * Architect — public re-exports (FASE 13.5b/1)
 * ---------------------------------------------------------------------------
 * Single entry for new code that wants the architect module surface.
 * Prefer importing from specific submodules (`./orchestration`,
 * `./dispatch`, `./governance`) so the dependency graph stays explicit,
 * but `from './delegation'` also works for convenience.
 *
 *   import { dispatchWorkItem } from '../li./delegation/dispatch';
 *   import { resolveToolDecision } from '../li./delegation/governance';
 *   import { shouldDelegate } from '../li./delegation/orchestration';
 *
 * Pre-13.5b call sites still import from '../lib/architect-delegation'
 * directly; those are honored via the deprecated pass-through shim in
 * that file and will be migrated in 13.5c.
 */

export * from './governance';
export * from './orchestration';
export * from './dispatch';
