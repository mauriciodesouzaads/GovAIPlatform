/**
 * OpenClaude gRPC Client
 *
 * Speaks to an openclaude-runner container via bidirectional gRPC stream.
 * Returns an EventEmitter so callers can react to streaming events without blocking.
 *
 * Events emitted:
 *   'text_chunk'        { text: string }
 *   'thinking_chunk'    { text: string }                              (FASE 14.0/3a)
 *   'tool_start'        { tool_name, arguments_json, tool_use_id }
 *   'tool_result'       { tool_name, output, is_error, tool_use_id }
 *   'action_required'   { prompt_id, question, type }
 *   'subagent_spawn'    { tool_use_id, subagent_type, description, prompt }   (FASE 14.0/3b)
 *   'subagent_complete' { tool_use_id, result_text, is_error }                (FASE 14.0/3b)
 *   'file_changed'      { event, path, timestamp_unix_ms }                    (FASE 14.0/3b)
 *   'done'              { full_text, prompt_tokens, completion_tokens, session_id }
 *   'error'             { message, code }
 *   'end'               (stream closed)
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { EventEmitter } from 'events';

// Proto path: works for both ts-node (src/) and compiled output (dist/)
const PROTO_PATH = (() => {
    // Try relative to this file first (works with ts-node)
    const candidates = [
        path.resolve(__dirname, '../proto/openclaude.proto'),
        path.resolve(process.cwd(), 'src/proto/openclaude.proto'),
        path.resolve(process.cwd(), 'dist/proto/openclaude.proto'),
    ];
    for (const p of candidates) {
        try {
            require('fs').accessSync(p);
            return p;
        } catch {
            // try next
        }
    }
    return candidates[0]; // fallback — will fail loudly at loadSync
})();

let _packageDefinition: ReturnType<typeof protoLoader.loadSync> | null = null;
let _protoDescriptor: any = null;

function getAgentService() {
    if (!_protoDescriptor) {
        _packageDefinition = protoLoader.loadSync(PROTO_PATH, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        _protoDescriptor = grpc.loadPackageDefinition(_packageDefinition!) as any;
    }
    return _protoDescriptor.openclaude.v1.AgentService;
}

export interface OpenClaudeRunConfig {
    /** TCP target, e.g. 'openclaude-runner:50051'. Used as fallback when socketPath is empty. */
    host: string;
    /** Optional unix socket path. When set, takes precedence over host. */
    socketPath?: string;
    message: string;
    workingDirectory: string;
    model?: string;
    sessionId: string;
    /** Default 300_000 ms (5 min) */
    timeoutMs?: number;
    // ─── FASE 14.0/3a — Claude Code SDK foundation knobs ──────────────────
    // Optional. When set, the runner resumes the named CLI session
    // instead of starting fresh. Conversation history is loaded from
    // the runner's on-disk store.
    resumeSessionId?: string;
    // Enable extended thinking on the underlying model. Effective only
    // for runners that wire it through (claude-code today).
    enableThinking?: boolean;
    // Hint for thinking budget; the runner maps this to the closest
    // CLI effort level (low/medium/high/xhigh/max).
    thinkingBudgetTokens?: number;
    // ─── FASE 14.0/3b · Feature 2: subagents ──────────────────────────
    // When true, runner drops --bare and exposes Task tool (and
    // sibling tools — Glob/Grep/WebFetch/Write/etc.) to the model.
    enableSubagents?: boolean;
    // ─── FASE 14.0/3b · Feature 1: MCP servers ──────────────────────────
    // Optional list of MCP server configs the runner should mount on
    // this run. Empty / omitted = no MCP servers.
    mcpServers?: Array<{
        name: string;
        transport: 'stdio' | 'sse' | 'http';
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
    }>;
}

/**
 * Resolve the gRPC target string from runtime env. Prefers unix socket
 * (lower latency, no port exposure, no TCP listener at all) when
 * OPENCLAUDE_SOCKET_PATH is set; otherwise falls back to TCP.
 */
export function resolveOpenClaudeTarget(): { socketPath?: string; host: string } {
    const socketPath = process.env.OPENCLAUDE_SOCKET_PATH;
    const host = process.env.OPENCLAUDE_GRPC_HOST || 'openclaude-runner:50051';
    return socketPath ? { socketPath, host } : { host };
}

export interface OpenClaudeHandle {
    emitter: EventEmitter;
    /** Send CancelSignal and close stream */
    cancel: () => void;
    /** Send UserInput (auto-approve or human reply) */
    respond: (promptId: string, reply: string) => void;
}

/**
 * Pick the gRPC target for this run. Prefers unix socket when it exists
 * and is accessible; falls back to TCP when the socket is missing /
 * EACCES / otherwise unreachable. This is the runtime-side symmetry
 * counterpart of `isRuntimeAvailable` (FASE 13.5a3): the availability
 * check and the actual dial now agree on "socket first, TCP fallback".
 *
 * FASE 13.5b/0 — closes the "14 UNAVAILABLE: No connection established"
 * failure mode where a missing socket file would surface a bare gRPC
 * error instead of transparently using the TCP host configured in the
 * same target object.
 */
export function pickTransportTarget(
    config: OpenClaudeRunConfig,
): { target: string; transport: 'unix' | 'tcp'; fallback: boolean } {
    if (config.socketPath) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs') as typeof import('fs');
            fs.accessSync(config.socketPath);
            return {
                target: `unix:${config.socketPath}`,
                transport: 'unix',
                fallback: false,
            };
        } catch (err) {
            const msg = (err as Error)?.message || String(err);
            console.warn(
                `[openclaude-client] unix socket unavailable (${config.socketPath}): ${msg}. Falling back to TCP ${config.host}`,
            );
            return { target: config.host, transport: 'tcp', fallback: true };
        }
    }
    return { target: config.host, transport: 'tcp', fallback: false };
}

/**
 * Start an OpenClaude run.  Non-blocking — use the returned emitter to
 * react to events.  The returned promise never rejects; errors are emitted.
 */
export function executeOpenClaudeRun(config: OpenClaudeRunConfig): OpenClaudeHandle {
    const emitter = new EventEmitter();
    const AgentService = getAgentService();

    // Prefer unix socket when configured AND accessible; fall back to TCP
    // when the socket file is missing, EACCES, or otherwise unreachable.
    // See pickTransportTarget() above.
    const { target, transport, fallback } = pickTransportTarget(config);
    if (transport === 'unix') {
        // Happy path — silent. gRPC accepts `unix:/absolute/path` (single
        // slash) or `unix:///abs/path` (three).
    } else if (fallback) {
        // Already warned in pickTransportTarget().
    }

    const client = new AgentService(
        target,
        grpc.credentials.createInsecure(),
        { 'grpc.max_receive_message_length': 4 * 1024 * 1024 }
    );
    const call = client.Chat() as grpc.ClientDuplexStream<any, any>;

    const timeoutMs = config.timeoutMs ?? 300_000;
    let settled = false;

    const settle = () => { settled = true; };

    const timer = setTimeout(() => {
        if (!settled) {
            try { call.write({ cancel: { reason: 'Timeout exceeded' } }); call.end(); } catch { /* ignore */ }
            emitter.emit('error', { message: 'Run timed out', code: 'TIMEOUT' });
            settle();
        }
    }, timeoutMs);

    // Send initial ChatRequest
    call.write({
        request: {
            message: config.message,
            working_directory: config.workingDirectory,
            ...(config.model ? { model: config.model } : {}),
            session_id: config.sessionId,
            // FASE 14.0/3a: only include the new optional fields when
            // explicitly set, so runners that haven't picked up the
            // proto change yet don't see undefined keys cluttering
            // the wire payload.
            ...(config.resumeSessionId
                ? { resume_session_id: config.resumeSessionId } : {}),
            ...(config.enableThinking !== undefined
                ? { enable_thinking: config.enableThinking } : {}),
            ...(config.thinkingBudgetTokens !== undefined
                ? { thinking_budget_tokens: config.thinkingBudgetTokens } : {}),
            // FASE 14.0/3b · Feature 1: pass-through MCP server configs.
            ...(config.mcpServers && config.mcpServers.length > 0
                ? { mcp_servers: config.mcpServers } : {}),
            // FASE 14.0/3b · Feature 2: subagents enable flag.
            ...(config.enableSubagents !== undefined
                ? { enable_subagents: Boolean(config.enableSubagents) } : {}),
        },
    });

    // FASE 13.5b/2 — per-turn idle timeout guard.
    //
    // The `timer` above bounds the WHOLE run. This new `turnTimer` aborts
    // the stream if no event arrives for `turnTimeoutMs` — the specific
    // symptom of Cerebras multi-turn flakiness observed in 13.5a3 where
    // tools completed but the final LLM turn just hung. Each incoming
    // event resets the idle clock. Opt out by setting
    // RUNTIME_TURN_TIMEOUT_MS=0.
    const turnTimeoutMs = parseInt(
        process.env.RUNTIME_TURN_TIMEOUT_MS || '60000', 10,
    );
    let turnTimer: NodeJS.Timeout | null = null;
    const resetTurnTimer = () => {
        if (turnTimeoutMs <= 0) return;
        if (turnTimer) clearTimeout(turnTimer);
        turnTimer = setTimeout(() => {
            if (settled) return;
            console.warn(
                `[openclaude-client] per-turn idle >${turnTimeoutMs}ms (session=${config.sessionId}); aborting stream`,
            );
            try { call.write({ cancel: { reason: 'turn_idle_timeout' } }); call.end(); } catch { /* ignore */ }
            emitter.emit('error', {
                message: `No stream activity for ${turnTimeoutMs}ms`,
                code: 'TURN_IDLE_TIMEOUT',
            });
            settle();
        }, turnTimeoutMs);
    };
    resetTurnTimer();

    call.on('data', (serverMessage: any) => {
        resetTurnTimer();
        if (serverMessage.text_chunk) {
            emitter.emit('text_chunk', serverMessage.text_chunk);
        } else if (serverMessage.thinking_chunk) {
            // FASE 14.0/3a — extended thinking deltas. Forwarded as a
            // distinct event so the adapter can persist them under a
            // separate event_type='THINKING' (auditable separately
            // from the final answer).
            emitter.emit('thinking_chunk', serverMessage.thinking_chunk);
        } else if (serverMessage.subagent_spawn) {
            // FASE 14.0/3b · Feature 2
            emitter.emit('subagent_spawn', serverMessage.subagent_spawn);
        } else if (serverMessage.subagent_complete) {
            emitter.emit('subagent_complete', serverMessage.subagent_complete);
        } else if (serverMessage.file_changed) {
            // FASE 14.0/3b · Feature 3
            emitter.emit('file_changed', serverMessage.file_changed);
        } else if (serverMessage.tool_start) {
            emitter.emit('tool_start', serverMessage.tool_start);
        } else if (serverMessage.tool_result) {
            emitter.emit('tool_result', serverMessage.tool_result);
        } else if (serverMessage.action_required) {
            emitter.emit('action_required', serverMessage.action_required);
        } else if (serverMessage.done) {
            clearTimeout(timer);
            if (turnTimer) clearTimeout(turnTimer);
            settle();
            emitter.emit('done', serverMessage.done);
        } else if (serverMessage.error) {
            clearTimeout(timer);
            if (turnTimer) clearTimeout(turnTimer);
            settle();
            emitter.emit('error', serverMessage.error);
        }
    });

    call.on('error', (err: any) => {
        clearTimeout(timer);
        if (turnTimer) clearTimeout(turnTimer);
        if (!settled) {
            settle();
            emitter.emit('error', { message: err?.message || String(err), code: 'GRPC_ERROR' });
        }
    });

    call.on('end', () => {
        clearTimeout(timer);
        emitter.emit('end');
    });

    return {
        emitter,
        cancel: () => {
            try { call.write({ cancel: { reason: 'Cancelled by GovAI' } }); call.end(); } catch { /* ignore */ }
        },
        respond: (promptId: string, reply: string) => {
            try { call.write({ input: { reply, prompt_id: promptId } }); } catch { /* ignore */ }
        },
    };
}
