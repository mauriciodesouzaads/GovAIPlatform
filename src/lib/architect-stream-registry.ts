/**
 * Architect Stream Registry — FASE 5-hardening
 *
 * Process-local map of active OpenClaude gRPC streams keyed by work_item_id.
 * The adapter (architect-delegation.ts) registers itself when it starts a
 * run; the worker (architect.worker.ts) reads from it when processing
 * `cancel-run` or `resolve-approval` jobs so it can call cancel() / respond()
 * on the live stream.
 *
 * This file exists as a separate module so the adapter and the worker can
 * both import it without creating a circular dependency.
 *
 * NOTE: this is process-local. In a multi-instance deployment we would need
 * to broadcast cancel/approve via Redis pub/sub or sticky-route the work
 * item to the same instance that owns its stream. For v1 the BullMQ worker
 * concurrency is 2 per process and approvals are short-lived, so a single
 * in-memory map is fine.
 */

export interface RegisteredStream {
    cancel: () => void;
    respond: (promptId: string, reply: string) => void;
}

const activeStreams = new Map<string, RegisteredStream>();

export function registerStream(workItemId: string, handle: RegisteredStream): void {
    activeStreams.set(workItemId, handle);
}

export function unregisterStream(workItemId: string): void {
    activeStreams.delete(workItemId);
}

export function getStream(workItemId: string): RegisteredStream | undefined {
    return activeStreams.get(workItemId);
}

export function activeStreamCount(): number {
    return activeStreams.size;
}
