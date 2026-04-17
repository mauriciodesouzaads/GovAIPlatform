/**
 * claude-code-runner/bridge.js — FASE 7
 * ---------------------------------------------------------------------------
 * Thin gRPC shim that exposes the real Anthropic Claude Code CLI behind the
 * same openclaude.proto the GovAI adapter already talks to. The adapter
 * (src/lib/architect-delegation.ts → runGrpcRuntimeAdapter) doesn't know or
 * care which runner it's connected to — it just sees TextChunk, ToolCallStart,
 * ToolCallResult, FinalResponse, and ErrorResponse events coming over the
 * stream.
 *
 * Input → Output mapping:
 *
 *   Incoming ClientMessage.request {
 *       message: string          →  Prompt passed to `claude -p "..."`
 *       working_directory        →  spawn cwd
 *       model                    →  `--model <model>` on the CLI
 *       session_id               →  logged; not used by the CLI today but
 *                                   kept in scope for future `claude --resume`
 *                                   continuation.
 *   }
 *
 *   CLI stdout (stream-json)     →  One JSON envelope per line. Envelope
 *                                   shapes:
 *
 *     { type: "system", subtype: "init", ... }
 *     { type: "assistant", message: { role, content: [...] } }
 *     { type: "user", message: { role, content: [{ type: "tool_result", ... }] } }
 *     { type: "result", is_error, result, usage: { input_tokens, output_tokens } }
 *
 *   The "content" arrays carry nested blocks: text, tool_use, tool_result.
 *   Each block maps into a proto event the adapter expects.
 *
 * Non-interactive approval: the CLI in `-p` (print) mode does NOT pause to
 * ask the user. Approvals happen at the GovAI layer BEFORE the CLI is ever
 * invoked — the adapter's `resolveToolDecision` classifier and `auto_all`
 * mode gate which tools are allowed. Unsafe tools that slip through still
 * get surfaced as ActionRequired events so the GovAI UI can render them,
 * but the CLI itself never blocks waiting for UserInput. We also pass
 * `--dangerously-skip-permissions` so the CLI's own permission prompt
 * doesn't deadlock a non-interactive stream.
 *
 * Cancel: sending ClientMessage.cancel kills the spawned process with
 * SIGTERM. End of stream is emitted when the CLI exits.
 * ---------------------------------------------------------------------------
 */

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROTO_PATH = path.join(__dirname, 'proto', 'openclaude.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition).openclaude.v1;

/** Best-effort JSON parse that never throws. */
function safeParse(line) {
    try { return JSON.parse(line); } catch { return null; }
}

/**
 * The Claude Code CLI's assistant/user envelopes wrap the model's content
 * as an array of blocks. This walks one envelope and emits the matching
 * proto events on the open gRPC stream. Accumulates full_text for the
 * FinalResponse and tracks usage for billing reporting.
 */
function handleCliEnvelope(env, call, state) {
    if (!env || typeof env !== 'object') return;

    // ── assistant message — may include text + tool_use blocks ────────────
    if (env.type === 'assistant' && env.message && Array.isArray(env.message.content)) {
        for (const block of env.message.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof block.text === 'string') {
                state.fullText += block.text;
                try {
                    call.write({ text_chunk: { text: block.text } });
                } catch (e) { /* call already ended */ }
            } else if (block.type === 'tool_use') {
                const toolUseId = block.id || crypto.randomUUID();
                try {
                    call.write({
                        tool_start: {
                            tool_name: block.name || 'unknown',
                            arguments_json: JSON.stringify(block.input || {}),
                            tool_use_id: toolUseId,
                        },
                    });
                } catch (e) { /* call already ended */ }
            }
        }
        return;
    }

    // ── user message — carries tool_result blocks back from the runtime ──
    if (env.type === 'user' && env.message && Array.isArray(env.message.content)) {
        for (const block of env.message.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'tool_result') {
                // content can be a string or an array of content parts;
                // flatten to a single text blob for the proto.
                let output = '';
                if (typeof block.content === 'string') {
                    output = block.content;
                } else if (Array.isArray(block.content)) {
                    output = block.content
                        .map(c => (c && typeof c === 'object' && typeof c.text === 'string') ? c.text : '')
                        .filter(Boolean)
                        .join('\n');
                }
                try {
                    call.write({
                        tool_result: {
                            tool_name: 'tool_result',
                            output,
                            is_error: Boolean(block.is_error),
                            tool_use_id: block.tool_use_id || '',
                        },
                    });
                } catch (e) { /* call already ended */ }
            }
        }
        return;
    }

    // ── result envelope — terminal, carries usage ──────────────────────────
    if (env.type === 'result') {
        // result text (final answer the CLI prints) may be redundant with
        // the accumulated text_chunks — prefer whichever is longer so we
        // don't lose content if the streaming path missed a block.
        if (typeof env.result === 'string' && env.result.length > state.fullText.length) {
            state.fullText = env.result;
        }
        const usage = env.usage || {};
        state.promptTokens = Number(usage.input_tokens || 0);
        state.completionTokens = Number(usage.output_tokens || 0);
        if (env.is_error) {
            state.error = {
                message: typeof env.result === 'string' && env.result ? env.result : 'Claude Code CLI reported an error',
                code: 'CLI_REPORTED_ERROR',
            };
        }
        return;
    }

    // ── system envelope — just log, nothing to forward ─────────────────────
    if (env.type === 'system') {
        // Useful for diagnostic logs; not forwarded to the adapter.
        if (process.env.DEBUG === '1') {
            console.log('[claude-code-runner system]', env.subtype || 'message');
        }
    }
}

/**
 * Handle a single bidirectional stream.
 */
function handleChat(call) {
    let proc = null;
    let cancelled = false;
    const state = {
        fullText: '',
        promptTokens: 0,
        completionTokens: 0,
        error: null,
        stdoutBuffer: '',
        stderrBuffer: '',
    };

    call.on('data', (msg) => {
        if (msg.request) {
            const req = msg.request;

            // FASE 11: probe mode. The platform sends `message="__govai_probe__"`
            // to check health without incurring an Anthropic API call. Reply
            // immediately with a synthetic done event so GET /v1/admin/runtimes
            // can report availability without spending credits.
            if (req.message === '__govai_probe__') {
                try {
                    call.write({ done: { full_text: 'probe_ok', prompt_tokens: 0, completion_tokens: 0 } });
                } catch (_) { /* call already ended */ }
                try { call.end(); } catch (_) { /* already ended */ }
                return;
            }

            const cwd = (req.working_directory && req.working_directory.trim())
                || ('/tmp/govai-workspaces/' + crypto.randomUUID());
            try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* ignore */ }

            const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
            // FASE 12: CLI 2.1.112 does NOT have --max-turns. Budget control
            // uses --max-budget-usd instead (default: 0.50 USD per call, tunable
            // via CLAUDE_CODE_MAX_BUDGET_USD). --bare skips hooks/LSP/plugin
            // sync to minimize overhead for server-mode invocation.
            const maxBudgetUsd = String(process.env.CLAUDE_CODE_MAX_BUDGET_USD || '0.50');

            const args = [
                '-p',                                   // print / non-interactive
                '--output-format', 'stream-json',       // one JSON envelope per line
                '--input-format', 'text',               // plain text input
                '--dangerously-skip-permissions',       // GovAI handles approvals upstream
                '--max-budget-usd', maxBudgetUsd,       // per-call USD cap (FASE 12)
                '--bare',                               // skip hooks/LSP/plugin sync
                '--no-session-persistence',             // don't write session files
                '--verbose',                            // richer events for the adapter timeline
            ];
            if (req.model && req.model.trim()) {
                args.push('--model', req.model.trim());
            }
            // The prompt is the final positional argument. `-p` + positional
            // means "run once and print the result" — the CLI reads stdin only
            // when we pass `--input-format stream-json`.
            args.push(req.message || '');

            const env = {
                ...process.env,
                HOME: '/tmp',
                // Preserve ANTHROPIC_API_KEY; the CLI will 401 cleanly if it's
                // missing so the adapter surfaces the real error instead of
                // us pre-checking and lying to the user.
            };

            console.log(`[claude-code-runner] spawning ${claudePath} with ${args.length} args, cwd=${cwd}`);
            try {
                // FASE 12: stdio[0]='ignore' — close stdin explicitly. The CLI
                // otherwise waits 3s for stdin before proceeding when --input-format=text
                // and prompt is a positional arg (observed as "no stdin data received in 3s"
                // warning on first real E2E run).
                proc = spawn(claudePath, args, {
                    cwd,
                    env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            } catch (err) {
                try {
                    call.write({ error: { message: `spawn failed: ${err.message}`, code: 'SPAWN_ERROR' } });
                    call.end();
                } catch { /* ignore */ }
                return;
            }

            proc.stdout.on('data', (chunk) => {
                state.stdoutBuffer += chunk.toString('utf8');
                // Split on newlines; keep the last (possibly incomplete) fragment in the buffer.
                const lines = state.stdoutBuffer.split('\n');
                state.stdoutBuffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const env = safeParse(line);
                    if (env) handleCliEnvelope(env, call, state);
                }
            });

            proc.stderr.on('data', (chunk) => {
                state.stderrBuffer += chunk.toString('utf8');
                // Surface the most recent line on every flush so operators can
                // see live progress in docker logs. The full buffer is attached
                // to the error payload if the CLI exits non-zero.
                const lines = chunk.toString('utf8').split('\n').filter(Boolean);
                for (const line of lines) {
                    console.error('[claude-code-runner cli]', line.substring(0, 500));
                }
            });

            proc.on('close', (code) => {
                if (cancelled) return;

                // Drain any trailing buffered line (no trailing newline).
                if (state.stdoutBuffer.trim()) {
                    const env = safeParse(state.stdoutBuffer);
                    if (env) handleCliEnvelope(env, call, state);
                    state.stdoutBuffer = '';
                }

                if (code === 0 && !state.error) {
                    try {
                        call.write({
                            done: {
                                full_text: state.fullText || '',
                                prompt_tokens: state.promptTokens || 0,
                                completion_tokens: state.completionTokens || 0,
                            },
                        });
                    } catch { /* already ended */ }
                } else {
                    const message = state.error?.message
                        || (state.stderrBuffer.trim()
                            ? `Claude Code CLI exited with code ${code}. stderr: ${state.stderrBuffer.substring(0, 500)}`
                            : `Claude Code CLI exited with code ${code}`);
                    try {
                        call.write({
                            error: {
                                message,
                                code: state.error?.code || 'CLI_EXIT_NON_ZERO',
                            },
                        });
                    } catch { /* already ended */ }
                }
                try { call.end(); } catch { /* ignore */ }
            });

            proc.on('error', (err) => {
                try {
                    call.write({
                        error: { message: err.message || String(err), code: 'SPAWN_ERROR' },
                    });
                    call.end();
                } catch { /* ignore */ }
            });

            return;
        }

        if (msg.cancel) {
            cancelled = true;
            console.log('[claude-code-runner] cancel received:', msg.cancel.reason || '(no reason)');
            if (proc) {
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
            }
            try { call.end(); } catch { /* ignore */ }
            return;
        }

        if (msg.input) {
            // The CLI is non-interactive in print mode — we don't forward
            // UserInput. GovAI's approval bridge handles approvals BEFORE
            // the request ever reaches the CLI (see the auto_all / auto_safe
            // logic in src/lib/architect-delegation.ts).
            console.log('[claude-code-runner] UserInput received but CLI is non-interactive; ignoring');
        }
    });

    call.on('end', () => {
        if (proc) {
            try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }
    });

    call.on('error', (err) => {
        console.error('[claude-code-runner call error]', err.message || err);
        if (proc) {
            try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }
    });
}

// ── Server bootstrap ───────────────────────────────────────────────────────
const server = new grpc.Server();
server.addService(proto.AgentService.service, { Chat: handleChat });

const host = process.env.GRPC_HOST || '0.0.0.0';
const port = parseInt(process.env.GRPC_PORT || '50051', 10);
const socketPath = process.env.GRPC_SOCKET_PATH;

// Unix socket bind (preferred by the adapter — lower latency, no TCP exposure).
// The TCP listener below is still bound so the compose healthcheck and
// external tooling can reach the service on port 50051.
if (socketPath) {
    // FASE 12: handle stale sockets from previous runs. The shared volume
    // persists socket files across container restarts. If the file exists
    // but we can't delete it (perm mismatch between root and node user),
    // fall back to TCP-only rather than crash.
    try {
        if (fs.existsSync(socketPath)) {
            fs.unlinkSync(socketPath);
        }
    } catch (err) {
        console.warn(`[claude-code-runner] Could not remove stale socket ${socketPath}: ${err.message}. Continuing with TCP only.`);
    }
    server.bindAsync(`unix://${socketPath}`, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) {
            console.error('[claude-code-runner] unix socket bind failed:', err.message || err);
            return;
        }
        console.log(`[claude-code-runner] gRPC bound on unix://${socketPath}`);
        try { fs.chmodSync(socketPath, 0o666); } catch { /* ignore */ }
    });
}

server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
        console.error('[claude-code-runner] TCP bind failed:', err.message || err);
        process.exit(1);
    }
    console.log(`[claude-code-runner] gRPC Server running at ${host}:${boundPort}`);
});
