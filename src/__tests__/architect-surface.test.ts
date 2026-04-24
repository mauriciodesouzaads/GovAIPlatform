/**
 * Sanity check that the runtime/* namespace exposes the APIs that
 * code completion can find. If any of these imports fails to resolve,
 * the refactor broke the surface.
 *
 * Renamed from delegation/ to runtime/ in FASE 14.0/2.
 * `getAutoDelegationWorkflowGraphId` was removed in 14.0/2 along with
 * the workflow_graph_id column it resolved.
 */
import { describe, it, expect } from 'vitest';

import {
    shouldDelegate,
    runtimeFromPrefix,
} from '../lib/runtime/orchestration';
import {
    dispatchWorkItem,
    runOpenClaudeAdapter,
} from '../lib/runtime/dispatch';
import {
    resolveToolDecision,
    insertWorkItemEvent,
    recoverOrphanedPendingWorkItems,
    detectAndMarkStuckWorkItems,
} from '../lib/runtime/governance';
// Barrel also resolves
import * as runtime from '../lib/runtime';

describe('runtime public surface', () => {
    it('orchestration exports are functions', () => {
        expect(typeof shouldDelegate).toBe('function');
        expect(typeof runtimeFromPrefix).toBe('function');
    });

    it('dispatch exports are functions', () => {
        expect(typeof dispatchWorkItem).toBe('function');
        expect(typeof runOpenClaudeAdapter).toBe('function');
    });

    it('governance exports are functions', () => {
        expect(typeof resolveToolDecision).toBe('function');
        expect(typeof insertWorkItemEvent).toBe('function');
        expect(typeof recoverOrphanedPendingWorkItems).toBe('function');
        expect(typeof detectAndMarkStuckWorkItems).toBe('function');
    });

    it('barrel re-exports all three submodules', () => {
        expect(typeof runtime.shouldDelegate).toBe('function');
        expect(typeof runtime.dispatchWorkItem).toBe('function');
        expect(typeof runtime.resolveToolDecision).toBe('function');
    });
});
