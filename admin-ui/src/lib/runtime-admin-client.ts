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
