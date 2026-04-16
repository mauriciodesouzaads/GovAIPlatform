# ADR-012: Distributed Stream Registry for Multi-Replica Deployments

## Status: Accepted

## Context

The Architect approval bridge relies on a process-local Map keyed by
work_item_id to track live OpenClaude/Claude Code gRPC streams. When a
worker picks up a `cancel-run` or `resolve-approval` job, it calls
`getStream(workItemId)` to find the stream's `cancel()` or `respond()`
handle.

This works perfectly in single-instance deployments. In multi-replica k8s:

1. User sends message → load balancer picks replica A → adapter runs,
   registers stream locally on A
2. User clicks "Approve" later → load balancer picks replica B → enqueues
   resolve-approval
3. BullMQ picks the job on replica C (any replica can consume)
4. C calls `getStream(workItemId)` → empty (stream is on A) → silent failure

## Decision

Introduce a Redis pub/sub layer (`architect-stream-registry-redis.ts`) that
broadcasts control messages to all replicas. The replica that owns the
stream locally acts on it; others ignore.

Feature flag `STREAM_REGISTRY_MODE`:
- `local` (default): no pub/sub, single-instance only
- any other value (`distributed`): publish on every cancel/respond; all
  replicas subscribe and filter by local ownership

## Why pub/sub, not streams or queues

Control messages are:
- **Idempotent** (sending "cancel" twice is safe)
- **Short-lived** (acted on within seconds)
- **Fan-out by design** (we don't know which replica owns the stream)

Redis pub/sub gives exactly this. Streams/queues add persistence overhead
we don't need because the BullMQ job retries are our persistence layer.

## Channel

`govai:architect:control`

## Message shape

```json
{
  "type": "cancel" | "respond",
  "workItemId": "uuid",
  "originInstance": "hex-12-chars",
  "promptId": "...",
  "reply": "yes" | "no",
  "timestamp": 1700000000000
}
```

## Trade-offs

- **Subscriber memory:** every replica subscribes and parses every message.
  For M replicas and N approvals/sec, cost is O(M·N). In practice M < 20
  and N < 10/sec per tenant → negligible.
- **Missed messages:** pub/sub is fire-and-forget. If a replica is down
  when the message arrives, it won't replay on recovery. Mitigated by
  BullMQ job retry — if respond() fails, the approval stays pending and
  the user can retry.
- **Network partition:** split-brain is possible in a short window.
  Mitigated by the fact that stream ownership changes only on pod restart
  (which kills the stream anyway).

## Alternatives considered

- **Sticky sessions**: would require ALB/ingress config per deployment.
  Rejected because it shifts burden to infra teams and doesn't handle
  worker-side (BullMQ consumers independent of HTTP routing).
- **Consistent-hash routing** of jobs: complex and still breaks on pod
  churn. Rejected.
- **External state (Postgres)**: persist stream metadata. Rejected because
  the stream itself is in-memory gRPC — you can't "recover" it across
  replicas.

## Consequences

- Multi-replica deployments set `STREAM_REGISTRY_MODE=distributed`
- Single-instance dev stays on `local` (zero network traffic)
- Testing approval bridge must run with Redis available
- `INSTANCE_ID` is logged in every pub/sub message for debugging
