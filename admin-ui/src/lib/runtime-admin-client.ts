/**
 * Runtime Admin API client — FASE 14.0/5b.1
 * ---------------------------------------------------------------------------
 * Thin fetch wrapper over /v1/admin/runtime/*. Used directly from React
 * components/hooks. The repo-wide axios instance (`@/lib/api`) handles
 * the rest of the admin surface, but `fetch` is required here for one
 * specific reason: SSE on /work-items/:id/events/stream needs to be
 * read incrementally via ReadableStream, which axios doesn't support
 * in the browser.
 *
 * The client takes a fresh auth token + orgId on every call so it can
 * be instantiated cheaply per render — no caching, no global state.
 */

import type {
    RuntimeWorkItemSummary,
    RuntimeWorkItemListResponse,
    RuntimeWorkItemDetailResponse,
    RuntimeSessionListResponse,
    RuntimeRunnerHealthResponse,
} from '@/types/runtime-admin';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface RuntimeAdminClientOpts {
    token: string;
    orgId: string;
}

export interface ListWorkItemsFilters {
    status?: string[];
    runtime_profile_slug?: string;
    parent_work_item_id?: string | null;
    session_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
    // 6c.B.2 — filtros das 3 sub-abas em /evidencias
    source?: 'chat' | 'admin' | 'api' | 'test' | 'all';
    q?: string;  // busca substring em title (ILIKE)
}

export interface SseEvent {
    event: string;
    data: unknown;
}

export class RuntimeAdminClient {
    constructor(private readonly opts: RuntimeAdminClientOpts) {}

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        return {
            Authorization: `Bearer ${this.opts.token}`,
            'x-org-id': this.opts.orgId,
            ...extra,
        };
    }

    async listWorkItems(
        filters: ListWorkItemsFilters = {},
        signal?: AbortSignal,
    ): Promise<RuntimeWorkItemListResponse> {
        const params = new URLSearchParams();
        if (filters.status?.length) params.set('status', filters.status.join(','));
        if (filters.runtime_profile_slug) params.set('runtime_profile_slug', filters.runtime_profile_slug);
        if (filters.parent_work_item_id !== undefined) {
            // explicit `null` in the URL means top-level only; backend
            // disambiguates via the literal string "null".
            params.set('parent_work_item_id', filters.parent_work_item_id ?? 'null');
        }
        if (filters.session_id) params.set('session_id', filters.session_id);
        if (filters.since) params.set('since', filters.since);
        if (filters.until) params.set('until', filters.until);
        if (filters.limit) params.set('limit', String(filters.limit));
        if (filters.cursor) params.set('cursor', filters.cursor);
        // 6c.B.2 — sub-abas /evidencias
        if (filters.source && filters.source !== 'all') params.set('source', filters.source);
        if (filters.q) params.set('q', filters.q);

        const url = `${API_BASE}/v1/admin/runtime/work-items?${params.toString()}`;
        const r = await fetch(url, { headers: this.headers(), signal });
        if (!r.ok) throw new Error(`listWorkItems: HTTP ${r.status}`);
        return r.json();
    }

    async getWorkItem(id: string, signal?: AbortSignal): Promise<RuntimeWorkItemDetailResponse> {
        const r = await fetch(`${API_BASE}/v1/admin/runtime/work-items/${id}`, {
            headers: this.headers(),
            signal,
        });
        if (!r.ok) {
            if (r.status === 404) throw new Error('work_item not found');
            throw new Error(`getWorkItem: HTTP ${r.status}`);
        }
        return r.json();
    }

    async listSessions(signal?: AbortSignal): Promise<RuntimeSessionListResponse> {
        const r = await fetch(`${API_BASE}/v1/admin/runtime/sessions`, {
            headers: this.headers(),
            signal,
        });
        if (!r.ok) throw new Error(`listSessions: HTTP ${r.status}`);
        return r.json();
    }

    async runnersHealth(signal?: AbortSignal): Promise<RuntimeRunnerHealthResponse> {
        const r = await fetch(`${API_BASE}/v1/admin/runtime/runners/health`, {
            headers: this.headers(),
            signal,
        });
        if (!r.ok) throw new Error(`runnersHealth: HTTP ${r.status}`);
        return r.json();
    }

    async cancelWorkItem(id: string): Promise<{ cancelled: boolean }> {
        // Body-less POST — DO NOT send Content-Type: application/json
        // (Fastify's default JSON parser rejects empty bodies with 500).
        const r = await fetch(`${API_BASE}/v1/admin/runtime/work-items/${id}/cancel`, {
            method: 'POST',
            headers: this.headers(),
        });
        if (!r.ok) {
            if (r.status === 404) throw new Error('work_item not cancellable (terminal)');
            throw new Error(`cancelWorkItem: HTTP ${r.status}`);
        }
        return r.json();
    }

    // ── Work item creation (5b.2) ──────────────────────────────────────
    //
    // The body discriminates on `mode`. The backend zod schema validates
    // the rest; we let the server be authoritative on shape and only
    // surface a user-friendly error message here.
    async createWorkItem(body: CreateWorkItemBody): Promise<CreateWorkItemResponse> {
        const r = await fetch(`${API_BASE}/v1/admin/runtime/work-items`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const detail = await r.json().catch(() => ({}));
            const msg = (detail as any)?.error || `HTTP ${r.status}`;
            throw new Error(`createWorkItem: ${msg}`);
        }
        return r.json();
    }

    // ── HITL approve-action (5b.2) ─────────────────────────────────────
    //
    // The legacy /v1/admin/architect/.../approve-action moved here.
    // Body shape is identical.
    async approveAction(
        workItemId: string,
        body: { prompt_id: string; approved: boolean; approve_mode?: 'single' | 'auto_all' | 'auto_safe' }
    ): Promise<{ queued: boolean }> {
        const r = await fetch(`${API_BASE}/v1/admin/runtime/work-items/${workItemId}/approve-action`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const detail = await r.json().catch(() => ({}));
            const msg = (detail as any)?.error || `HTTP ${r.status}`;
            throw new Error(`approveAction: ${msg}`);
        }
        return r.json();
    }

    // ── Assistant catalog (5b.2 — Modo Agente picker) ──────────────────
    //
    // GET /v1/admin/assistants returns the full catalog row, including
    // the new fixture self-description columns added by migration 093.
    // Modo Agente filters down to status='published' and orders fixtures
    // first, then user-created agents alphabetically.
    async listAssistants(): Promise<{ assistants: AssistantSummary[] }> {
        const r = await fetch(`${API_BASE}/v1/admin/assistants`, {
            headers: this.headers(),
        });
        if (!r.ok) throw new Error(`listAssistants: HTTP ${r.status}`);
        const raw = await r.json();
        // The legacy endpoint returns an array directly OR { assistants: [...] }.
        // Normalize.
        const list: any[] = Array.isArray(raw) ? raw : (raw?.assistants ?? raw?.items ?? []);
        const assistants: AssistantSummary[] = list.map(a => ({
            id: a.id,
            name: a.name,
            description: a.description ?? null,
            status: a.status,
            lifecycle_state: a.lifecycle_state ?? null,
            risk_level: a.risk_level ?? null,
            shield_level: a.shield_level ?? null,
            runtime_profile_slug: a.runtime_profile_slug ?? null,
            is_fixture: a.is_fixture ?? false,
            default_runtime_options: a.default_runtime_options ?? {},
            default_mcp_server_ids: a.default_mcp_server_ids ?? [],
        }));
        return { assistants };
    }

    // ── MCP server registry (5b.2 — Modo Livre toggles) ────────────────
    async listMcpServers(): Promise<{ servers: McpServerSummary[] }> {
        const r = await fetch(`${API_BASE}/v1/admin/mcp-servers`, {
            headers: this.headers(),
        });
        if (!r.ok) throw new Error(`listMcpServers: HTTP ${r.status}`);
        const raw = await r.json();
        const list: any[] = Array.isArray(raw) ? raw : (raw?.items ?? raw?.servers ?? []);
        const servers: McpServerSummary[] = list.map(s => ({
            id: s.id,
            name: s.name,
            transport: s.transport,
            enabled: s.enabled,
        }));
        return { servers };
    }

    /**
     * SSE consumer via fetch + ReadableStream. EventSource can't carry
     * the custom Authorization header (browser API limitation), so we
     * parse the SSE wire format manually.
     *
     * Each yielded chunk is one SSE record:
     *   `event: <name>` followed by `data: <json>` followed by blank line.
     *
     * The generator returns when the server emits `event: stream_end`
     * OR the connection closes OR the AbortSignal fires.
     */
    async *streamEvents(
        workItemId: string,
        signal?: AbortSignal,
    ): AsyncGenerator<SseEvent, void, unknown> {
        const url = `${API_BASE}/v1/admin/runtime/work-items/${workItemId}/events/stream`;
        const r = await fetch(url, {
            headers: this.headers({ Accept: 'text/event-stream' }),
            signal,
        });
        if (!r.ok || !r.body) {
            throw new Error(`streamEvents: HTTP ${r.status}`);
        }

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });

                // Split on \n; keep the last (possibly partial) line in
                // the buffer for the next iteration.
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (line.startsWith(':')) {
                        // SSE comment / keep-alive — skip silently.
                        continue;
                    }
                    if (line.startsWith('event:')) {
                        currentEvent = line.slice(6).trim();
                        continue;
                    }
                    if (line.startsWith('data:')) {
                        const dataStr = line.slice(5).trim();
                        let data: unknown = dataStr;
                        try { data = JSON.parse(dataStr); } catch { /* keep raw */ }
                        const ev: SseEvent = {
                            event: currentEvent || 'message',
                            data,
                        };
                        yield ev;
                        if (currentEvent === 'stream_end') return;
                        currentEvent = '';
                        continue;
                    }
                    // empty line = end of one record; nothing to do.
                }
            }
        } finally {
            try { reader.releaseLock(); } catch { /* already released */ }
        }
    }
}

/** Hook-like factory: returns a client bound to the current auth state. */
export function createRuntimeAdminClient(token: string, orgId: string): RuntimeAdminClient {
    return new RuntimeAdminClient({ token, orgId });
}

// Re-export the summary type for convenience in component files that
// only import from this module.
export type { RuntimeWorkItemSummary };

// ── Types specific to 5b.2 endpoints ───────────────────────────────────

export interface AssistantSummary {
    id: string;
    name: string;
    description: string | null;
    status: string;
    lifecycle_state: string | null;
    risk_level: string | null;
    shield_level: number | null;
    runtime_profile_slug: string | null;
    is_fixture: boolean;
    default_runtime_options: Record<string, unknown>;
    default_mcp_server_ids: string[];
}

export interface McpServerSummary {
    id: string;
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    enabled: boolean;
}

export interface RuntimeOptionsBody {
    resume_session_id?: string;
    enable_thinking?: boolean;
    thinking_budget_tokens?: number;
    enable_subagents?: boolean;
}

export type CreateWorkItemBody =
    | {
        mode: 'agent';
        assistant_id: string;
        message: string;
        runtime_options?: RuntimeOptionsBody;
        mcp_server_ids?: string[];
      }
    | {
        mode: 'freeform';
        runtime_profile_slug: 'openclaude' | 'claude_code_official' | 'aider';
        message: string;
        system_prompt?: string;
        model?: string;
        runtime_options?: RuntimeOptionsBody;
        mcp_server_ids?: string[];
      };

export interface CreateWorkItemResponse {
    accepted: boolean;
    work_item_id: string;
    runtime_profile_slug: string;
    execution_mode: 'agent' | 'freeform';
    assistant_id: string | null;
    mcp_server_ids: string[];
}
