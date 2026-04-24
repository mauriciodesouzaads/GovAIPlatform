/**
 * Runtime — public re-exports
 * ---------------------------------------------------------------------------
 * Single entry for code that wants the runtime delegation surface.
 * Prefer importing from specific submodules (`./orchestration`,
 * `./dispatch`, `./governance`) so the dependency graph stays explicit,
 * but `from '../lib/runtime'` also works for convenience.
 *
 *   import { dispatchWorkItem }     from '../lib/runtime/dispatch';
 *   import { resolveToolDecision } from '../lib/runtime/governance';
 *   import { shouldDelegate }       from '../lib/runtime/orchestration';
 *
 * Renamed from `delegation/` in FASE 14.0/2 alongside the table rename
 * (the old delegation table → runtime_work_items). Importing directly from
 * `../lib/runtime-delegation` is also supported.
 */

export * from './governance';
export * from './orchestration';
export * from './dispatch';
