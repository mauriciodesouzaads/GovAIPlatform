/**
 * Chat Native API client — FASE 14.0/6c.A
 * ---------------------------------------------------------------------------
 * Thin fetch wrapper around /v1/chat/* (the user-facing chat product).
 * Mirrors the runtime-admin-client pattern from 5b.1: fetch (not axios)
 * because POST /messages SSE streams need ReadableStream.
 *
 * Auth + orgId provided per call so the same client survives token
 * rotation. SSE iterator yields parsed JSON envelopes from the
 * server, not raw OpenAI deltas — see chat-native.routes.ts for
 * envelope shape.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface ChatClientOpts {
    token: string;
    orgId: string;
}

export type ConversationMode = 'chat' | 'code' | 'cowork';

export interface Conversation {
    id: string;
    title: string;
    mode: ConversationMode;
    default_model: string;
    knowledge_base_ids: string[];
    pinned: boolean;
    archived: boolean;
    created_at: string;
    updated_at: string;
    last_message_at: string | null;
    // FASE 14.0/6c.A.1 — vínculo opcional com agente vertical.
    // Quando setado, a UI renderiza header com avatar+nome do agente
    // e empty state com suggested_prompts. Backend injeta system_prompt
    // do agente + KBs + skills automaticamente em POST /messages.
    assistant_id?: string | null;
    assistant_name?: string | null;
    assistant_avatar?: string | null;
    assistant_category?: string | null;
    assistant_description?: string | null;
    assistant_suggested_prompts?: string[];
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    model: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    latency_ms: number | null;
    finish_reason: string | null;
    tool_calls: unknown;
    attachments_ids: string[];
    created_at: string;
}

export interface LlmProvider {
    provider: string;
    model_id: string;
    display_name: string;
    description: string | null;
    context_window: number | null;
    max_output: number | null;
    capabilities: string[];
    is_default: boolean;
    icon_emoji: string | null;
    sort_order: number;
}

export type StreamEnvelope =
    | { type: 'delta'; content: string }
    | {
        type: 'done';
        user_message_id: string;
        assistant_message_id: string | null;
        tokens: { in: number; out: number };
        finish_reason: string | null;
        latency_ms: number;
      }
    | { type: 'error'; error: string };

export class ChatClient {
    constructor(private readonly opts: ChatClientOpts) {}

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        return {
            Authorization: `Bearer ${this.opts.token}`,
            'x-org-id': this.opts.orgId,
            ...extra,
        };
    }

    async listProviders(signal?: AbortSignal): Promise<LlmProvider[]> {
        const r = await fetch(`${API_BASE}/v1/chat/llm-providers`, {
            headers: this.headers(),
            signal,
        });
        if (!r.ok) throw new Error(`listProviders: HTTP ${r.status}`);
        const j = await r.json();
        return j.providers ?? [];
    }

    async listConversations(
        opts: { archived?: boolean; search?: string; limit?: number } = {},
        signal?: AbortSignal,
    ): Promise<Conversation[]> {
        const p = new URLSearchParams();
        if (opts.archived !== undefined) p.set('archived', String(opts.archived));
        if (opts.search) p.set('search', opts.search);
        if (opts.limit) p.set('limit', String(opts.limit));
        const r = await fetch(`${API_BASE}/v1/chat/conversations?${p.toString()}`, {
            headers: this.headers(),
            signal,
        });
        if (!r.ok) throw new Error(`listConversations: HTTP ${r.status}`);
        const j = await r.json();
        return j.conversations ?? [];
    }

    async getConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
        const r = await fetch(`${API_BASE}/v1/chat/conversations/${id}`, {
            headers: this.headers(),
            signal,
        });
        if (!r.ok) {
            if (r.status === 404) throw new Error('conversation not found');
            throw new Error(`getConversation: HTTP ${r.status}`);
        }
        return r.json();
    }

    async createConversation(
        body: {
            title?: string;
            default_model?: string;
            knowledge_base_ids?: string[];
            // 6c.A.1 — vínculo com agente. Backend resolve title +
            // default_model do agente quando body não sobrescreve.
            assistant_id?: string;
        } = {},
    ): Promise<Conversation> {
        const r = await fetch(`${API_BASE}/v1/chat/conversations`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`createConversation: HTTP ${r.status}`);
        return r.json();
    }

    async patchConversation(
        id: string,
        patch: Partial<Pick<Conversation, 'title' | 'pinned' | 'archived' | 'default_model' | 'knowledge_base_ids'>>,
    ): Promise<Conversation> {
        const r = await fetch(`${API_BASE}/v1/chat/conversations/${id}`, {
            method: 'PATCH',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error(`patchConversation: HTTP ${r.status}`);
        return r.json();
    }

    async deleteConversation(id: string): Promise<void> {
        const r = await fetch(`${API_BASE}/v1/chat/conversations/${id}`, {
            method: 'DELETE',
            headers: this.headers(),
        });
        if (!r.ok && r.status !== 204) {
            throw new Error(`deleteConversation: HTTP ${r.status}`);
        }
    }

    async listMessages(convId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
        const r = await fetch(`${API_BASE}/v1/chat/conversations/${convId}/messages`, {
            headers: this.headers(),
            signal,
        });
        if (!r.ok) throw new Error(`listMessages: HTTP ${r.status}`);
        const j = await r.json();
        return j.messages ?? [];
    }

    /**
     * Streams an assistant response for a user message. Yields envelopes
     * as the server sends them. Aborting the signal closes the stream;
     * the server persists whatever was sent up to that point.
     */
    async *sendMessage(
        convId: string,
        body: { content: string; model: string; attachments_ids?: string[] },
        signal?: AbortSignal,
    ): AsyncGenerator<StreamEnvelope, void, unknown> {
        const r = await fetch(`${API_BASE}/v1/chat/conversations/${convId}/messages`, {
            method: 'POST',
            headers: this.headers({
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            }),
            body: JSON.stringify(body),
            signal,
        });
        if (!r.ok || !r.body) {
            const text = await r.text().catch(() => '');
            throw new Error(`sendMessage: HTTP ${r.status} ${text.substring(0, 200)}`);
        }

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });

                let nl;
                while ((nl = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line || !line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (!payload) continue;
                    try {
                        const env = JSON.parse(payload) as StreamEnvelope;
                        yield env;
                        if (env.type === 'done' || env.type === 'error') return;
                    } catch {
                        /* malformed line — skip */
                    }
                }
            }
        } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
        }
    }

    async uploadAttachment(
        convId: string,
        file: File,
    ): Promise<{ id: string; filename: string; mime_type: string; size_bytes: number }> {
        const form = new FormData();
        form.append('file', file);
        const r = await fetch(`${API_BASE}/v1/chat/conversations/${convId}/attachments`, {
            method: 'POST',
            headers: this.headers(),
            body: form,
        });
        if (!r.ok) throw new Error(`uploadAttachment: HTTP ${r.status}`);
        return r.json();
    }
}

export function createChatClient(token: string, orgId: string): ChatClient {
    return new ChatClient({ token, orgId });
}
