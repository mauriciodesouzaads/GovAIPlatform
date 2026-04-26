/**
 * Runtime Stream Registry — FASE 5-hardening + FASE 9 distributed
 * (renamed from architect-stream-registry in FASE 14.0/5b.2)
 *
 * Process-local map of active OpenClaude/Claude Code/Aider gRPC streams keyed
 * by work_item_id. The adapter (runtime-delegation.ts) registers itself when
 * it starts a run; the worker (runtime.worker.ts) reads from it when
 * processing `cancel-run` or `resolve-approval` jobs so it can call
 * cancel() / respond() on the live stream.
 *
 * This file exists as a separate module so the adapter and the worker can
 * both import it without creating a circular dependency.
 *
 * For multi-instance deployments (k8s with >1 replica), see
 * runtime-stream-registry-redis.ts which broadcasts cancel/respond via
 * Redis pub/sub so any replica can resolve an approval or cancel a run
 * regardless of which replica owns the stream. Feature flag:
 *   STREAM_REGISTRY_MODE=distributed   (default: local)
 */

import { randomBytes } from 'crypto';

/** Unique id per process lifetime. Used by the Redis pub/sub layer to
 *  identify which instance published a control message. */
export const INSTANCE_ID: string = process.env.GOVAI_INSTANCE_ID || randomBytes(6).toString('hex');

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
