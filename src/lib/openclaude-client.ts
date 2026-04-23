/**
 * OpenClaude gRPC Client
 *
 * Speaks to an openclaude-runner container via bidirectional gRPC stream.
 * Returns an EventEmitter so callers can react to streaming events without blocking.
 *
 * Events emitted:
 *   'text_chunk'       { text: string }
 *   'tool_start'       { tool_name, arguments_json, tool_use_id }
 *   'tool_result'      { tool_name, output, is_error, tool_use_id }
 *   'action_required'  { prompt_id, question, type }
 *   'done'             { full_text, prompt_tokens, completion_tokens }
 *   'error'            { message, code }
 *   'end'              (stream closed)
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
        },
    });

    call.on('data', (serverMessage: any) => {
        if (serverMessage.text_chunk) {
            emitter.emit('text_chunk', serverMessage.text_chunk);
        } else if (serverMessage.tool_start) {
            emitter.emit('tool_start', serverMessage.tool_start);
        } else if (serverMessage.tool_result) {
            emitter.emit('tool_result', serverMessage.tool_result);
        } else if (serverMessage.action_required) {
            emitter.emit('action_required', serverMessage.action_required);
        } else if (serverMessage.done) {
            clearTimeout(timer);
            settle();
            emitter.emit('done', serverMessage.done);
        } else if (serverMessage.error) {
            clearTimeout(timer);
            settle();
            emitter.emit('error', serverMessage.error);
        }
    });

    call.on('error', (err: any) => {
        clearTimeout(timer);
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
