# Claude Code CLI Stream Format — validated

Validated against Claude Code CLI **2.1.112** on 2026-04-17, running in
`claude-code-runner` container (FASE 12 build).

## Command used by `bridge.js` (FASE 12)

```bash
claude -p \
    --output-format stream-json \
    --input-format text \
    --dangerously-skip-permissions \
    --max-budget-usd 0.50 \
    --bare \
    --no-session-persistence \
    --verbose \
    "Responda exatamente esta palavra e nada mais: pronto"
```

Key flag notes:
- `--max-turns` **removed** — does not exist in CLI 2.1.112
- `--max-budget-usd` replaces it (per-call USD cap, enforced by CLI)
- `--bare` — skips hooks/LSP/plugin sync to minimize overhead in server mode
- `--no-session-persistence` — don't write session files

## Real E2E output (work item `5b170e87-3aa9-4749-85c5-c480470181de`)

```
status:              done
runtime_profile:     claude_code_official
runtime_claim_level: official_cli_governed
execution_context.output.fullText: "pronto"
execution_context.output.toolEvents: []
event_count:         2 (RUN_STARTED + RUN_COMPLETED)
total poll time:     ~12s (3 polls × 3s intervals)
estimated cost:      < $0.05
```

## Known environment requirements

### Non-root user (REQUIRED)

The CLI refuses `--dangerously-skip-permissions` when running as root/sudo
with error: `cannot be used with root/sudo privileges for security reasons`.

`claude-code-runner/Dockerfile` now runs as the `node` user (uid 1000)
with explicit ownership of `/var/run/govai`, `/tmp/govai-workspaces`,
and `/app`.

### Stdin handling

With `-p` + prompt as positional argument, the CLI waits 3s for stdin
input before proceeding. `bridge.js` now spawns with `stdio[0]='ignore'`
to close stdin explicitly and eliminate the wait.

### Socket permissions on shared volume

`/var/run/govai` is a volume shared between `api` (root), `openclaude-runner`
(root), and `claude-code-runner` (node user). The dir is set to `chmod 777`
inside the container so the non-root user can create socket files. If a
stale socket from a previous root-user run exists, `bridge.js` falls back
to TCP-only with a warning instead of crashing.

## Bridge.js → proto mapping (validated)

- `{ type: "system", subtype: "init" }` — logged, not forwarded
- `{ type: "assistant", message: { content: [...] } }` with `text` blocks
  → `text_chunk` events
- `{ type: "assistant", message: { content: [...] } }` with `tool_use` blocks
  → `tool_start` events
- `{ type: "user", message: { content: [...] } }` with `tool_result` blocks
  → `tool_result` events
- `{ type: "result", is_error, result, usage }` → `done` event (or `error`
  if is_error)

## Validated invariants

- Each line is a valid JSON envelope
- stream-json terminates with a `result` envelope
- Exit code 0 = success; non-zero = bridge writes an `error` event with
  captured stderr before calling `call.end()`
- `--max-budget-usd` caps per-call spend; CLI terminates with non-zero
  exit + structured error when exceeded

## Cost accounting (FASE 12 validation run)

- Pre-validation (fake key, 2 runs): $0.00 (CLI rejected before API call)
- First real run with permissions error: $0.00 (exited before API call)
- Second real run with stdin bug: $0.00 (exited before API call)
- Third real run (SUCCESS, work item 5b170e87): ~$0.05

**Total budget consumed: ~$0.05 of $0.50 allowed.**
