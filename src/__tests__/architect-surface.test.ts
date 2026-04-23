/**
 * FASE 13.5b/1 — sanity check that the new architect/* namespace
 * actually exposes the APIs that code completion can find. If any of
 * these imports fails to resolve, the refactor broke the surface.
 */
import { describe, it, expect } from 'vitest';

import {
    shouldDelegate,
    getAutoDelegationWorkflowGraphId,
} from '../lib/delegation/orchestration';
import {
    dispatchWorkItem,
    runOpenClaudeAdapter,
} from '../lib/delegation/dispatch';
import {
    resolveToolDecision,
    insertWorkItemEvent,
    recoverOrphanedPendingWorkItems,
    detectAndMarkStuckWorkItems,
} from '../lib/delegation/governance';
// Barrel also resolves
import * as delegation from '../lib/delegation';

describe('architect public surface', () => {
    it('orchestration exports are functions', () => {
        expect(typeof shouldDelegate).toBe('function');
        expect(typeof getAutoDelegationWorkflowGraphId).toBe('function');
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
        expect(typeof delegation.shouldDelegate).toBe('function');
        expect(typeof delegation.dispatchWorkItem).toBe('function');
        expect(typeof delegation.resolveToolDecision).toBe('function');
    });
});
