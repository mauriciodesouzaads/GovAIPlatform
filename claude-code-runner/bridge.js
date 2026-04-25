/**
 * claude-code-runner/bridge.js
 * ---------------------------------------------------------------------------
 * Thin gRPC shim that exposes the real Anthropic Claude Code CLI behind the
 * shared openclaude.proto. The adapter (src/lib/runtime-delegation.ts →
 * runGrpcRuntimeAdapter) doesn't know which runner it talks to — it just
 * sees TextChunk, ThinkingChunk, ToolCallStart, ToolCallResult,
 * FinalResponse, and ErrorResponse events on the stream.
 *
 * Input → CLI mapping:
 *
 *   ClientMessage.request {
 *       message               → prompt (positional arg)
 *       working_directory     → spawn cwd
 *       model                 → --model <model>
 *       resume_session_id     → --resume <id>           (FASE 14.0/3a)
 *       enable_thinking       → --effort high           (FASE 14.0/3a)
 *       thinking_budget_tokens→ tunes the effort level   (FASE 14.0/3a)
 *       (no resume_session_id)→ --session-id <new-uuid> so we always
 *                                know the session deterministically
 *   }
 *
 * CLI envelope → proto event mapping:
 *
 *   {type:"assistant", content:[{type:"thinking",thinking}]}    → ThinkingChunk
 *   {type:"assistant", content:[{type:"text",text}]}            → TextChunk
 *   {type:"assistant", content:[{type:"tool_use",name,input,id}]}→ ToolCallStart
 *   {type:"user",      content:[{type:"tool_result",content,..}]}→ ToolCallResult
 *   {type:"system",    subtype:"init", session_id}              → captures sid
 *   {type:"result",    is_error,result,usage}                   → terminal
 *
 * Sessions: dropped --no-session-persistence in 14.0/3a so the CLI writes
 * conversation history to /tmp/.claude/projects/... (mounted as the
 * claude_code_state named volume so it survives container restarts).
 * `--session-id`/`--resume` work in -p (print) mode in CLI 2.1.117+.
 *
 * Redis session index (runtime:sessions:<orgId>): on FinalResponse the
 * runner upserts a hash entry keyed by session_id with last_used_unix_ms
 * + work_item_id + runtime slug. Etapa 5 admin UI lists from this index;
 * the conversation state itself stays on the CLI's disk store.
 *
 * Cancel: ClientMessage.cancel kills the spawned CLI with SIGTERM.
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

// ── Redis (lazy init) ───────────────────────────────────────────────────────
// We only require ioredis when REDIS_URL is set. This keeps the runner
// startable in test environments without Redis (e.g. when only running the
// proto/grpc smoke tests). When Redis is unavailable the session-index
// upsert silently no-ops; the CLI's on-disk store still works.
let redisClient = null;
function getRedis() {
    if (redisClient !== null) return redisClient;
    if (!process.env.REDIS_URL) {
        redisClient = false;  // sentinel: don't try again
        return null;
    }
    try {
        const IORedis = require('ioredis');
        redisClient = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
        redisClient.on('error', err => {
            console.warn('[claude-code-runner redis]', err.message);
        });
    } catch (err) {
        console.warn('[claude-code-runner] ioredis not available:', err.message);
        redisClient = false;
    }
    return redisClient || null;
}

// 30 days in seconds — refreshed on every session use.
const SESSION_INDEX_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Best-effort JSON parse that never throws. */
function safeParse(line) {
    try { return JSON.parse(line); } catch { return null; }
}

/**
 * Extract orgId from a workspace path. Pattern set by the api side is:
 *     /tmp/govai-workspaces/<orgId>/<workspaceId>
 * Falls back to null if the path doesn't match — Redis indexing is then
 * skipped silently (the CLI's on-disk store still records the session).
 */
function orgIdFromCwd(cwd) {
    if (!cwd || typeof cwd !== 'string') return null;
    const m = cwd.match(/govai-workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
    return m ? m[1] : null;
}

/**
 * The CLI's assistant/user envelopes wrap content as block arrays. Walk
 * one envelope and emit matching proto events. Accumulates full_text for
 * the FinalResponse and tracks usage.
 */
function handleCliEnvelope(env, call, state) {
    if (!env || typeof env !== 'object') return;

    // ── system init: carries the session_id the CLI is using ──────────────
    if (env.type === 'system' && env.subtype === 'init') {
        // CLI 2.1.x: system init payload includes session_id when persistence
        // is enabled. We capture it so FinalResponse can echo it back even if
        // we didn't pre-generate one (defensive: the path that always
        // generates --session-id is taken below, so this is a fallback).
        if (typeof env.session_id === 'string' && env.session_id) {
            state.sessionId = state.sessionId || env.session_id;
        }
        if (process.env.DEBUG === '1') {
            console.log('[claude-code-runner system]', env.subtype || 'message', 'sid=', state.sessionId);
        }
        return;
    }

    // ── assistant message: thinking + text + tool_use blocks ──────────────
    if (env.type === 'assistant' && env.message && Array.isArray(env.message.content)) {
        // session_id may also be included on assistant envelopes
        if (typeof env.session_id === 'string' && env.session_id) {
            state.sessionId = state.sessionId || env.session_id;
        }
        for (const block of env.message.content) {
            if (!block || typeof block !== 'object') continue;

            // FASE 14.0/3a: extended thinking deltas. Anthropic stream-json
            // emits `thinking` blocks (sometimes with .delta wrapping when
            // --include-partial-messages is on). Normalize to a single
            // text payload — the adapter persists this as a separate
            // event_type='THINKING' so audit can see reasoning vs final
            // answer separately.
            if (block.type === 'thinking') {
                const text = typeof block.thinking === 'string'
                    ? block.thinking
                    : (typeof block.text === 'string' ? block.text : '');
                if (text) {
                    try {
                        call.write({ thinking_chunk: { text } });
                    } catch (e) { /* call already ended */ }
                }
                continue;
            }
            // Some streaming variants emit thinking as a delta block.
            if (block.type === 'thinking_delta' && typeof block.text === 'string') {
                try {
                    call.write({ thinking_chunk: { text: block.text } });
                } catch (e) { /* call already ended */ }
                continue;
            }

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

    // ── user message: tool_result blocks back from the runtime ─────────────
    if (env.type === 'user' && env.message && Array.isArray(env.message.content)) {
        for (const block of env.message.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'tool_result') {
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
        if (typeof env.result === 'string' && env.result.length > state.fullText.length) {
            state.fullText = env.result;
        }
        const usage = env.usage || {};
        state.promptTokens = Number(usage.input_tokens || 0);
        state.completionTokens = Number(usage.output_tokens || 0);
        if (typeof env.session_id === 'string' && env.session_id) {
            state.sessionId = state.sessionId || env.session_id;
        }
        if (env.is_error) {
            state.error = {
                message: typeof env.result === 'string' && env.result ? env.result : 'Claude Code CLI reported an error',
                code: 'CLI_REPORTED_ERROR',
            };
        }
        return;
    }
}

/**
 * Best-effort write to the Redis session index. Never throws; failures
 * are logged and swallowed so a Redis hiccup doesn't fail the LLM run.
 */
async function upsertSessionIndex({ orgId, sessionId, workItemId, runtimeSlug, messageCount }) {
    const r = getRedis();
    if (!r || !orgId || !sessionId) return;
    const key = `runtime:sessions:${orgId}`;
    const value = JSON.stringify({
        sessionId,
        lastUsedUnixMs: Date.now(),
        messageCount: messageCount || 0,
        runtimeSlug: runtimeSlug || 'claude_code_official',
        workItemId: workItemId || '',
    });
    try {
        await r.hset(key, sessionId, value);
        await r.expire(key, SESSION_INDEX_TTL_SECONDS);
    } catch (err) {
        console.warn('[claude-code-runner] session index upsert failed:', err.message);
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
        sessionId: '',
        orgId: null,
        workItemId: '',
    };

    call.on('data', (msg) => {
        if (msg.request) {
            const req = msg.request;

            // FASE 11: probe mode for /v1/admin/runtimes availability check.
            if (req.message === '__govai_probe__') {
                try {
                    call.write({ done: { full_text: 'probe_ok', prompt_tokens: 0, completion_tokens: 0, session_id: '' } });
                } catch (_) { /* call already ended */ }
                try { call.end(); } catch (_) { /* already ended */ }
                return;
            }

            const cwd = (req.working_directory && req.working_directory.trim())
                || ('/tmp/govai-workspaces/' + crypto.randomUUID());
            try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* ignore */ }

            state.orgId = orgIdFromCwd(cwd);
            // The session_id field on ChatRequest is the legacy non-CLI hint;
            // resume_session_id is the new explicit knob.
            const resumeId = (req.resume_session_id && req.resume_session_id.trim()) || '';
            // Always have a deterministic session id we can return in
            // FinalResponse: either the resumed one, or a freshly-minted
            // UUID we tell the CLI to use via --session-id.
            state.sessionId = resumeId || crypto.randomUUID();
            state.workItemId = (req.session_id && req.session_id.trim()) || ''; // adapter passes work_item_id here

            const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
            const maxBudgetUsd = String(process.env.CLAUDE_CODE_MAX_BUDGET_USD || '0.50');
            const enableThinking = Boolean(req.enable_thinking);
            const budget = Number(req.thinking_budget_tokens || 0);

            // FASE 14.0/3a: argv changes
            //   - dropped --no-session-persistence (we want sessions to land on disk)
            //   - added --include-partial-messages (so thinking deltas stream)
            //   - --session-id <new uuid> when not resuming, or --resume <id>
            //   - --effort <level> when enable_thinking is set
            const args = [
                '-p',                                       // print / non-interactive
                '--output-format', 'stream-json',           // one JSON envelope per line
                '--input-format', 'text',
                '--dangerously-skip-permissions',           // GovAI owns approvals upstream
                '--max-budget-usd', maxBudgetUsd,
                '--bare',
                '--include-partial-messages',               // FASE 14.0/3a: thinking + partial deltas
                '--verbose',
            ];
            if (resumeId) {
                args.push('--resume', resumeId);
            } else {
                args.push('--session-id', state.sessionId);
            }
            // FASE 14.0/3a — thinking is plumbed through the protocol but
            // intentionally NOT translated to a CLI flag. CLI 2.1.117
            // already sends `thinking: adaptive` on every request by
            // default; the only choice we have is "model that accepts
            // adaptive thinking" or "API rejection". `--effort` only
            // tunes the level, it doesn't disable adaptive. The
            // adapter still listens for ThinkingChunk events the CLI
            // emits naturally; the day a thinking-capable model lands
            // on the runtime path, THINKING events start showing up
            // with zero code change here.
            void enableThinking; void budget;
            // Model: explicit request, then env fallback. With Option α the
            // env defaults to the LiteLLM virtual model `govai-llm-anthropic`.
            const model = (req.model && req.model.trim()) || process.env.ANTHROPIC_MODEL;
            if (model) args.push('--model', model);
            args.push(req.message || '');

            const env = {
                ...process.env,
                HOME: '/tmp',  // CLI writes /tmp/.claude/{sessions,projects,...}
                // ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY come from the
                // container env (Option α points them at LiteLLM).
            };

            console.log(`[claude-code-runner] spawn cwd=${cwd} sid=${state.sessionId}${resumeId ? ' (resume)' : ''} thinking=${enableThinking}`);
            try {
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
                const lines = chunk.toString('utf8').split('\n').filter(Boolean);
                for (const line of lines) {
                    console.error('[claude-code-runner cli]', line.substring(0, 500));
                }
            });

            proc.on('close', async (code) => {
                if (cancelled) return;

                // Drain trailing buffered line.
                if (state.stdoutBuffer.trim()) {
                    const env = safeParse(state.stdoutBuffer);
                    if (env) handleCliEnvelope(env, call, state);
                    state.stdoutBuffer = '';
                }

                // FASE 14.0/3a: best-effort session-index upsert, regardless of
                // success/failure. We index even failed runs so users can see
                // the failed work_item linked to the session in the UI.
                await upsertSessionIndex({
                    orgId: state.orgId,
                    sessionId: state.sessionId,
                    workItemId: state.workItemId,
                    runtimeSlug: 'claude_code_official',
                    messageCount: 0,
                });

                if (code === 0 && !state.error) {
                    try {
                        call.write({
                            done: {
                                full_text: state.fullText || '',
                                prompt_tokens: state.promptTokens || 0,
                                completion_tokens: state.completionTokens || 0,
                                session_id: state.sessionId,
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

// FASE 14.0/3a: claim ownership of the CLI session-store mount point.
// The named volume `claude_code_state` mounted at /tmp/.claude is created
// by Docker as root:root on first attach. The CLI runs as user `node`
// (uid 1000) and silently fails to write its session JSONLs there —
// resumes then 400 with "No conversation found". Touching the dir as
// the running user (after Docker init) ensures we own the path before
// the first run lands. mkdirSync is idempotent; if the dir already has
// the right owner this is effectively a no-op.
try {
    const claudeRoot = '/tmp/.claude';
    fs.mkdirSync(claudeRoot, { recursive: true });
    // chmod 0700 isn't enough across uid mismatches; 0777 lets the CLI
    // write subdirs (projects/, sessions/) regardless of what owner the
    // volume mount surfaced. Sub-files keep CLI-assigned modes.
    fs.chmodSync(claudeRoot, 0o777);
    fs.mkdirSync(`${claudeRoot}/projects`, { recursive: true });
    fs.mkdirSync(`${claudeRoot}/sessions`, { recursive: true });
    fs.chmodSync(`${claudeRoot}/projects`, 0o777);
    fs.chmodSync(`${claudeRoot}/sessions`, 0o777);
} catch (err) {
    console.warn('[claude-code-runner] could not prep /tmp/.claude:', err.message);
}

const server = new grpc.Server();
server.addService(proto.AgentService.service, { Chat: handleChat });

const host = process.env.GRPC_HOST || '0.0.0.0';
const port = parseInt(process.env.GRPC_PORT || '50051', 10);
const socketPath = process.env.GRPC_SOCKET_PATH;

if (socketPath) {
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
