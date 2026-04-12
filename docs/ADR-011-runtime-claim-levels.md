# ADR-011: Runtime Claim Levels

## Status: Accepted

## Context

The platform supports two runtime modes: **official** (Claude Code) and
**open** (OpenClaude). The initial implementation of the official runtime
uses Claude Code CLI in print mode (`claude -p --output-format stream-json`)
via a gRPC bridge (`claude-code-runner/bridge.js`).

The CLI in print mode is a single-prompt, non-interactive executor. It:

- Runs the prompt once and streams JSON events to stdout.
- Does NOT support interactive approvals within the CLI itself — the CLI's
  built-in permission prompt is bypassed with `--dangerously-skip-permissions`,
  and approvals are handled by GovAI's upstream approval bridge.
- Does NOT support session continuation, agent-to-agent handoffs, or the
  full interactive agent loop.

This means the initial official runtime is **functional but not equivalent**
to the full Claude Code interactive experience.

## Decision

### Three claim levels

| Claim level            | Meaning                                                                 | Status   |
|------------------------|-------------------------------------------------------------------------|----------|
| `official_cli_governed`| Claude Code CLI in non-interactive print mode, governed by GovAI.       | Active   |
| `exact_governed`       | Full interactive Claude Code via Agent SDK, governed by GovAI.          | Reserved |
| `open_governed`        | OpenClaude runtime, multi-provider, governed by GovAI.                  | Active   |

### Rules

1. The `official_cli_governed` claim is used for the current bridge-based
   implementation. The UI shows "CLI Governed" next to the Official pill.

2. The `exact_governed` claim **MUST NOT** be used until a proper adapter
   using the Claude Agent SDK (or equivalent) is implemented and tested.
   Using this claim prematurely would misrepresent the product capability.

3. Both `official_cli_governed` and `open_governed` runtimes use the same
   `openclaude.proto` gRPC contract and the same `runOpenClaudeAdapter`
   adapter code. The only difference is the target host/socket.

## Consequences

- The UI distinguishes "CLI Governed" from "Open Governed" with a badge.
- `exact_governed` remains a first-class enum value in the schema so the
  migration to Agent SDK is a config change, not a schema change.
- Marketing and compliance documentation must use "CLI Governed" for the
  current official runtime, not "Exact Governed".
