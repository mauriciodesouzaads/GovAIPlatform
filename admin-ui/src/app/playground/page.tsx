'use client';

/**
 * GovAI Chat — FASE 6
 * ---------------------------------------------------------------------------
 * Production-grade governed chat surface. The visual direction is editorial /
 * legal-document: disciplined typography, monospaced metadata, generous
 * vertical rhythm, no toy-like animations. Every color comes from a design
 * token (bg-card, text-foreground, bg-primary, ...) — no raw violet/purple.
 *
 * Every message flows through the full /v1/execute pipeline (OPA, DLP,
 * FinOps, RAG, delegation, audit). Delegated runs render an inline card with
 * the live EventTimeline, human-approval bridge, and final markdown result.
 */

import {
    useState, useEffect, useCallback, useRef, useMemo,
} from 'react';
import { marked } from 'marked';
import api, { ENDPOINTS, API_BASE } from '@/lib/api';
import { getAuthToken } from '@/lib/auth-storage';
import { useAuth } from '@/components/AuthProvider';
import {
    MessageSquareText, Bot, Send, Shield, ShieldCheck, ShieldAlert,
    Sparkles, Zap, ChevronDown, Copy, Check, Loader2, X, Menu,
    AlertTriangle, AlertCircle, Clock, FileWarning, Ban, WifiOff,
    History, PauseCircle, ChevronRight,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface Assistant {
    id: string;
    name: string;
    description: string | null;
    status: string;
    lifecycle_state: string;
    delegation_config: {
        enabled: boolean;
        auto_delegate_patterns: string[];
        max_duration_seconds: number;
    } | null;
    delegation_enabled: boolean;
    capability_tags: string[];
    risk_level: string | null;
    skill_count: number;
}

interface LlmModel {
    id: string;
    name: string;
    provider: string;
    default?: boolean;
}

interface ChatSession {
    session_id: string;
    assistant_id: string;
    assistant_name: string | null;
    started_at: string;
    last_at: string;
    message_count: number;
    has_delegation: boolean;
}

interface WorkItemEvent {
    id: string;
    type: string;
    seq?: number;
    tool_name?: string | null;
    prompt_id?: string | null;
    metadata?: Record<string, any>;
    timestamp: string;
}

interface DelegationState {
    work_item_id: string;
    status: string;
    events: WorkItemEvent[];
    pendingApproval: { prompt_id: string; tool_name: string; question: string } | null;
    fullText: string | null;
    tokens: { prompt?: number; completion?: number } | null;
    toolCount: number;
    // FASE 6c: tracks the user's approval opt-in for this entire work item.
    // Surfaces the "⚡ Aprovação automática ativa" badge on the card so the
    // user knows they won't be asked again for this run.
    approvalMode: 'single' | 'auto_all' | 'auto_safe' | null;
}

type ApproveMode = 'single' | 'auto_all' | 'auto_safe';

type MessageRole =
    | 'user'
    | 'assistant'
    | 'delegation'
    | 'delegation_result'
    | 'error';

type ErrorKind =
    | 'rate_limit'
    | 'policy_block'
    | 'dlp_block'
    | 'quota_exceeded'
    | 'service_unavailable'
    | 'hitl_pending'
    | 'generic';

interface ChatMessage {
    id: string;
    role: MessageRole;
    content?: string;
    timestamp: number;
    // FASE 6b multi-agent: which assistant handled this turn
    assistantId?: string;
    assistantName?: string;
    // FASE 6b streaming: true while SSE chunks are still arriving
    streaming?: boolean;
    // Assistant response metadata
    traceId?: string;
    tokens?: { prompt?: number; completion?: number } | null;
    // Delegation
    workItemId?: string;
    matchedPattern?: string;
    // Errors
    errorKind?: ErrorKind;
    errorReason?: string;
    retryAfterSec?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function genId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(src: string): string {
    try {
        return marked.parse(src, { async: false }) as string;
    } catch {
        return src;
    }
}

function eventIcon(type: string): string {
    switch (type) {
        case 'RUN_STARTED':        return '▸';
        case 'TOOL_START':         return '◆';
        case 'TOOL_RESULT':        return '◇';
        case 'ACTION_REQUIRED':    return '!';
        case 'ACTION_RESPONSE':    return '✓';
        case 'RUN_COMPLETED':      return '●';
        case 'RUN_FAILED':         return '×';
        case 'RUN_CANCELLED':      return '⊘';
        default:                   return '·';
    }
}

function eventLabel(type: string): string {
    switch (type) {
        case 'RUN_STARTED':        return 'Execução iniciada';
        case 'TOOL_START':         return 'Ferramenta invocada';
        case 'TOOL_RESULT':        return 'Resultado recebido';
        case 'ACTION_REQUIRED':    return 'Aguardando aprovação';
        case 'ACTION_RESPONSE':    return 'Ação resolvida';
        case 'RUN_COMPLETED':      return 'Execução concluída';
        case 'RUN_FAILED':         return 'Execução falhou';
        case 'RUN_CANCELLED':      return 'Execução cancelada';
        default:                   return type;
    }
}

function classifyError(err: any): { kind: ErrorKind; reason: string; retryAfterSec?: number } {
    const status = err?.response?.status;
    const data = err?.response?.data ?? {};
    const reason: string = data.error || data.reason || data.message || err?.message || 'Erro inesperado';
    if (status === 429) {
        const retry = parseInt(err?.response?.headers?.['retry-after'] ?? '60', 10);
        return { kind: 'rate_limit', reason, retryAfterSec: isNaN(retry) ? 60 : retry };
    }
    if (status === 402 || /quota|cap/i.test(reason)) {
        return { kind: 'quota_exceeded', reason };
    }
    if (status === 403 && /dlp/i.test(reason)) {
        return { kind: 'dlp_block', reason };
    }
    if (status === 403) {
        return { kind: 'policy_block', reason };
    }
    if (status === 502 || status === 503 || status === 504) {
        return { kind: 'service_unavailable', reason };
    }
    if (status === 202 && data.status === 'PENDING_APPROVAL') {
        return { kind: 'hitl_pending', reason: data.reason || reason };
    }
    return { kind: 'generic', reason };
}

const SUGGESTIONS: Record<string, string[]> = {
    'Assistente Jurídico': [
        'Explique cláusulas de rescisão no direito brasileiro.',
        '[OPENCLAUDE] Gere um relatório de conformidade LGPD.',
        'Analise os riscos de um contrato de confidencialidade.',
    ],
    'FAQ Interno RH': [
        'Qual a política de férias da empresa?',
        'Como funciona o plano de saúde corporativo?',
        'Quantos dias de licença paternidade tenho direito?',
    ],
    'Análise de Crédito': [
        'Quais são os critérios para aprovação de crédito?',
        'Como é calculado o score de risco?',
        'Liste os documentos necessários para abertura de conta.',
    ],
};

function getSuggestions(name: string): string[] {
    return SUGGESTIONS[name] ?? [
        'Me dê uma visão geral das suas capacidades.',
        'Quais tópicos você cobre?',
        '[OPENCLAUDE] Analise o repositório e gere um relatório.',
    ];
}

// ── FASE 6b: multi-agent avatar (deterministic color per assistant ID) ──────
function assistantColor(id: string | undefined | null): string {
    if (!id) return 'hsl(160, 45%, 55%)';
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 45%, 58%)`;
}

function AssistantAvatar({
    name, id, size = 28,
}: {
    name: string | undefined | null;
    id: string | undefined | null;
    size?: number;
}) {
    const color = assistantColor(id);
    const initial = (name ?? 'A').trim().charAt(0).toUpperCase();
    return (
        <div
            className="rounded-full flex items-center justify-center font-semibold shrink-0 border"
            style={{
                width: size,
                height: size,
                backgroundColor: `${color}22`,
                color,
                borderColor: `${color}44`,
                fontSize: Math.round(size * 0.42),
            }}
            title={name ?? 'Assistente'}
        >
            {initial}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Small presentational components
// ═══════════════════════════════════════════════════════════════════════════

function TypingIndicator() {
    return (
        <div className="flex items-center gap-1.5 px-1 py-2">
            {[0, 1, 2].map(i => (
                <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60"
                    style={{ animation: `typing-bounce 1.4s ease-in-out ${i * 0.16}s infinite` }}
                />
            ))}
        </div>
    );
}

function CopyButton({
    text, className = '',
}: { text: string; className?: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            onClick={async (e) => {
                e.stopPropagation();
                try {
                    await navigator.clipboard.writeText(text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                } catch { /* ignore */ }
            }}
            title={copied ? 'Copiado' : 'Copiar'}
            className={`rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${className}`}
        >
            {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
    );
}

function Markdown({ content }: { content: string }) {
    const html = useMemo(() => renderMarkdown(content), [content]);
    const containerRef = useRef<HTMLDivElement>(null);

    // Post-render: decorate <pre> blocks with copy buttons. Avoids SSR markdown
    // libs and keeps the render synchronous.
    useEffect(() => {
        const root = containerRef.current;
        if (!root) return;
        const pres = root.querySelectorAll('pre');
        pres.forEach(pre => {
            const el = pre as HTMLElement;
            if (el.dataset.enhanced === 'true') return;
            el.dataset.enhanced = 'true';
            el.classList.add('group', 'relative');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent bg-card/80 border border-border/60';
            btn.title = 'Copiar';
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const code = pre.querySelector('code');
                const text = code?.textContent ?? pre.textContent ?? '';
                try {
                    await navigator.clipboard.writeText(text);
                    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-primary)"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                    setTimeout(() => {
                        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
                    }, 1600);
                } catch { /* ignore */ }
            });
            pre.appendChild(btn);
        });
    }, [html]);

    return (
        <div
            ref={containerRef}
            className="chat-md text-[15px] leading-relaxed text-foreground"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

function EventTimeline({ state }: { state: DelegationState }) {
    const events = state.events;
    if (events.length === 0 && state.status === 'pending') {
        return <div className="text-xs text-muted-foreground italic px-1">Aguardando dispatch…</div>;
    }
    if (events.length === 0 && state.status === 'in_progress') {
        return (
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                Conectando ao runtime…
            </div>
        );
    }
    return (
        <ol className="space-y-1.5 font-mono text-[11px]">
            {events.map(ev => (
                <li key={ev.id} className="flex items-start gap-3">
                    <span
                        className={
                            ev.type === 'RUN_COMPLETED' ? 'text-primary' :
                            ev.type === 'RUN_FAILED' ? 'text-destructive' :
                            ev.type === 'ACTION_REQUIRED' ? 'text-foreground' :
                            'text-muted-foreground'
                        }
                    >
                        {eventIcon(ev.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-foreground/90">{eventLabel(ev.type)}</span>
                            {ev.tool_name && (
                                <span className="text-muted-foreground">{ev.tool_name}</span>
                            )}
                        </div>
                        {ev.metadata?.question && (
                            <div className="text-muted-foreground mt-0.5 italic truncate">
                                &quot;{ev.metadata.question}&quot;
                            </div>
                        )}
                    </div>
                    <span className="text-muted-foreground/60 shrink-0">
                        {new Date(ev.timestamp).toLocaleTimeString('pt-BR', { hour12: false })}
                    </span>
                </li>
            ))}
        </ol>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Main page
// ═══════════════════════════════════════════════════════════════════════════

export default function GovAIChatPage() {
    const { role } = useAuth();
    void role;

    // ── Data ─────────────────────────────────────────────────────────────────
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [models, setModels] = useState<LlmModel[]>([]);
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [loadingInit, setLoadingInit] = useState(true);

    // ── Selection ────────────────────────────────────────────────────────────
    const [selectedAssistantId, setSelectedAssistantId] = useState<string | null>(null);
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [forceDelegate, setForceDelegate] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);

    // ── Conversation ─────────────────────────────────────────────────────────
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [sessionId] = useState<string>(() => genId());

    // ── Delegation polling ───────────────────────────────────────────────────
    const [delegationStates, setDelegationStates] = useState<Record<string, DelegationState>>({});
    const pollingTimers = useRef<Record<string, NodeJS.Timeout>>({});

    // ── Refs ─────────────────────────────────────────────────────────────────
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // ── FASE 6b: smart scroll ───────────────────────────────────────────────
    // Only auto-scroll to bottom when the user is already near the bottom.
    // When they scroll up to review, respect that position and show a
    // "Nova mensagem" badge that jumps back.
    const [isScrolledUp, setIsScrolledUp] = useState(false);

    const selectedAssistant = useMemo(
        () => assistants.find(a => a.id === selectedAssistantId) ?? null,
        [assistants, selectedAssistantId]
    );
    const selectedModel = useMemo(
        () => models.find(m => m.id === selectedModelId) ?? models.find(m => m.default) ?? models[0] ?? null,
        [models, selectedModelId]
    );

    // ── Load catalogs on mount ───────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [aRes, mRes, sRes] = await Promise.all([
                    api.get(ENDPOINTS.ASSISTANTS_AVAILABLE),
                    api.get(ENDPOINTS.LLM_MODELS),
                    api.get(ENDPOINTS.CHAT_SESSIONS).catch(() => ({ data: [] })),
                ]);
                if (cancelled) return;
                setAssistants(aRes.data || []);
                setModels(mRes.data || []);
                setSessions(sRes.data || []);
                const defModel = (mRes.data || []).find((m: LlmModel) => m.default) || (mRes.data || [])[0];
                if (defModel) setSelectedModelId(defModel.id);
            } finally {
                if (!cancelled) setLoadingInit(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // ── Draft persistence per assistant ──────────────────────────────────────
    useEffect(() => {
        if (!selectedAssistantId) {
            setInput('');
            return;
        }
        const saved = sessionStorage.getItem(`govai-draft-${selectedAssistantId}`);
        setInput(saved ?? '');
    }, [selectedAssistantId]);

    useEffect(() => {
        if (!selectedAssistantId) return;
        if (input) {
            sessionStorage.setItem(`govai-draft-${selectedAssistantId}`, input);
        } else {
            sessionStorage.removeItem(`govai-draft-${selectedAssistantId}`);
        }
    }, [input, selectedAssistantId]);

    // ── Smart auto-scroll: only if already near bottom ───────────────────────
    useEffect(() => {
        if (!isScrolledUp) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    }, [messages, delegationStates, isScrolledUp]);

    const handleMessagesScroll = useCallback(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        setIsScrolledUp(dist > 120);
    }, []);

    // ── Auto-resize textarea ─────────────────────────────────────────────────
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 220) + 'px';
    }, [input]);

    // ── Keyboard shortcuts: Ctrl/Cmd+K focus input, Escape clears input ────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                inputRef.current?.focus();
                return;
            }
            if (e.key === 'Escape' && document.activeElement === inputRef.current) {
                setInput('');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // ── Cleanup polling on unmount ───────────────────────────────────────────
    useEffect(() => {
        return () => {
            Object.values(pollingTimers.current).forEach(clearInterval);
            pollingTimers.current = {};
        };
    }, []);

    // ── Delegation polling ───────────────────────────────────────────────────
    const stopPolling = useCallback((workItemId: string) => {
        const t = pollingTimers.current[workItemId];
        if (t) {
            clearInterval(t);
            delete pollingTimers.current[workItemId];
        }
    }, []);

    const pollWorkItem = useCallback(async (workItemId: string) => {
        try {
            const res = await api.get(ENDPOINTS.ARCHITECT_WORK_ITEM_EVENTS(workItemId));
            const wi = res.data?.work_item;
            const evs: WorkItemEvent[] = res.data?.events || [];
            if (!wi) return;

            const pending = [...evs].reverse().find(e => e.type === 'ACTION_REQUIRED');
            const pendingApproval = pending && wi.status === 'awaiting_approval'
                ? {
                    prompt_id: pending.prompt_id ?? '',
                    tool_name: pending.tool_name ?? 'unknown',
                    question: (pending.metadata?.question as string) ?? 'Aprovar ferramenta?',
                }
                : null;

            setDelegationStates(prev => ({
                ...prev,
                [workItemId]: {
                    work_item_id: workItemId,
                    status: wi.status,
                    events: evs,
                    pendingApproval,
                    fullText: wi.execution_context?.output?.fullText ?? null,
                    tokens: wi.execution_context?.tokens ?? null,
                    toolCount: Array.isArray(wi.execution_context?.output?.toolEvents)
                        ? wi.execution_context.output.toolEvents.length : 0,
                    approvalMode: (wi.approval_mode
                        ?? wi.execution_context?.approval_mode
                        ?? null) as DelegationState['approvalMode'],
                },
            }));

            if (['done', 'cancelled', 'blocked'].includes(wi.status)) {
                stopPolling(workItemId);
                if (wi.status === 'done' && wi.execution_context?.output?.fullText) {
                    setMessages(prev => {
                        if (prev.some(m => m.role === 'delegation_result' && m.workItemId === workItemId)) {
                            return prev;
                        }
                        return [...prev, {
                            id: genId(),
                            role: 'delegation_result',
                            content: wi.execution_context.output.fullText,
                            workItemId,
                            tokens: wi.execution_context.tokens,
                            timestamp: Date.now(),
                        }];
                    });
                }
            }
        } catch {
            // polling errors are non-fatal — keep trying until terminal
        }
    }, [stopPolling]);

    const startPolling = useCallback((workItemId: string) => {
        if (pollingTimers.current[workItemId]) return;
        pollWorkItem(workItemId);
        pollingTimers.current[workItemId] = setInterval(() => pollWorkItem(workItemId), 2_000);
    }, [pollWorkItem]);

    // ── Helpers used by both stream and fallback code paths ─────────────────
    const appendAssistantResponse = useCallback((data: any, assistantSnap: Assistant | null) => {
        const content = data?.choices?.[0]?.message?.content ?? '(sem resposta)';
        const tokens = data?.usage
            ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
            : null;
        const traceId = data?._govai?.traceId ?? data?.trace_id;
        const aid = data?._govai?.assistantId ?? assistantSnap?.id;
        const aname = data?._govai?.assistantName ?? assistantSnap?.name ?? 'Assistente';
        setMessages(prev => [...prev, {
            id: genId(),
            role: 'assistant',
            content,
            tokens,
            traceId,
            assistantId: aid,
            assistantName: aname,
            timestamp: Date.now(),
        }]);
    }, []);

    const appendDelegationMessage = useCallback((data: any, assistantSnap: Assistant | null) => {
        const workItemId: string | undefined = data?._govai?.workItemId;
        if (!workItemId) return;
        const aid = data?._govai?.assistantId ?? assistantSnap?.id;
        const aname = data?._govai?.assistantName ?? assistantSnap?.name ?? 'Assistente';
        setMessages(prev => [...prev, {
            id: genId(),
            role: 'delegation',
            workItemId,
            matchedPattern: data._govai?.matchedPattern,
            traceId: data._govai?.traceId,
            assistantId: aid,
            assistantName: aname,
            timestamp: Date.now(),
        }]);
        setDelegationStates(prev => ({
            ...prev,
            [workItemId]: {
                work_item_id: workItemId,
                status: 'pending',
                events: [],
                pendingApproval: null,
                fullText: null,
                tokens: null,
                toolCount: 0,
                approvalMode: null,
            },
        }));
        startPolling(workItemId);
    }, [startPolling]);

    const appendErrorFromPayload = useCallback((status: number, data: any) => {
        const { kind, reason, retryAfterSec } = classifyError({ response: { status, data } });
        setMessages(prev => [...prev, {
            id: genId(),
            role: 'error',
            errorKind: kind,
            errorReason: reason,
            retryAfterSec,
            timestamp: Date.now(),
        }]);
    }, []);

    // ── Send handler (FASE 6b: fetch+SSE streaming with axios fallback) ─────
    const handleSend = useCallback(async () => {
        if (!selectedAssistantId) return;
        const trimmed = input.trim();
        if (!trimmed || sending) return;

        // Snapshot the assistant at send time — the user can switch mid-flight
        // and we still want the resulting message attributed correctly.
        const assistantSnap = assistants.find(a => a.id === selectedAssistantId) ?? null;

        const userMsg: ChatMessage = {
            id: genId(),
            role: 'user',
            content: trimmed,
            timestamp: Date.now(),
        };
        setMessages(prev => [...prev, userMsg]);
        setInput('');
        sessionStorage.removeItem(`govai-draft-${selectedAssistantId}`);
        setSending(true);

        const body = {
            assistant_id: selectedAssistantId,
            message: trimmed,
            session_id: sessionId,
            model: selectedModelId ?? undefined,
            force_delegate: forceDelegate,
        };

        const token = getAuthToken();

        // ── Primary path: SSE streaming ──────────────────────────────────────
        let streamFinished = false;
        let streamingMsgId: string | null = null;
        try {
            const response = await fetch(`${API_BASE}${ENDPOINTS.CHAT_SEND_STREAM}`, {
                method: 'POST',
                headers: {
                    'Authorization': token ? `Bearer ${token}` : '',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                // Non-2xx → read the body and surface as typed error
                let errData: any = null;
                try { errData = await response.json(); } catch { /* ignore */ }
                appendErrorFromPayload(response.status, errData ?? {});
                streamFinished = true;
                return;
            }

            const contentType = response.headers.get('content-type') ?? '';

            // Non-SSE JSON means the backend took the force_delegate shortcut
            if (!contentType.includes('text/event-stream')) {
                const data = await response.json();
                if (response.status === 202 && data?.status === 'PENDING_APPROVAL') {
                    setMessages(prev => [...prev, {
                        id: genId(),
                        role: 'error',
                        errorKind: 'hitl_pending',
                        errorReason: data.reason ?? 'Ação de alto risco detectada.',
                        timestamp: Date.now(),
                    }]);
                } else if (data?._govai?.delegated === true && data._govai.workItemId) {
                    appendDelegationMessage(data, assistantSnap);
                } else {
                    appendAssistantResponse(data, assistantSnap);
                }
                streamFinished = true;
                return;
            }

            // ── True SSE path ────────────────────────────────────────────────
            if (!response.body) throw new Error('No response body for SSE stream');

            // Insert an empty streaming message that we will progressively fill
            streamingMsgId = genId();
            setMessages(prev => [...prev, {
                id: streamingMsgId!,
                role: 'assistant',
                content: '',
                streaming: true,
                assistantId: assistantSnap?.id,
                assistantName: assistantSnap?.name ?? 'Assistente',
                timestamp: Date.now(),
            }]);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let accumulated = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    if (!frame.startsWith('data: ')) continue;
                    const raw = frame.slice(6).trim();
                    if (!raw) continue;

                    let evt: any;
                    try { evt = JSON.parse(raw); } catch { continue; }

                    if (evt.error) {
                        // Remove the empty streaming bubble; render a typed error instead
                        setMessages(prev => prev.filter(m => m.id !== streamingMsgId));
                        streamingMsgId = null;
                        appendErrorFromPayload(evt.status ?? 500, evt.data ?? {});
                        streamFinished = true;
                        try { reader.cancel(); } catch { /* ignore */ }
                        return;
                    }

                    if (evt.delegated) {
                        // Remove the empty streaming bubble; render the delegation card
                        setMessages(prev => prev.filter(m => m.id !== streamingMsgId));
                        streamingMsgId = null;
                        appendDelegationMessage(evt, assistantSnap);
                        streamFinished = true;
                        try { reader.cancel(); } catch { /* ignore */ }
                        return;
                    }

                    if (typeof evt.chunk === 'string') {
                        accumulated += evt.chunk;
                        setMessages(prev => prev.map(m =>
                            m.id === streamingMsgId ? { ...m, content: accumulated } : m
                        ));
                        continue;
                    }

                    if (evt.done) {
                        const tokens = evt.usage
                            ? { prompt: evt.usage.prompt_tokens, completion: evt.usage.completion_tokens }
                            : null;
                        setMessages(prev => prev.map(m =>
                            m.id === streamingMsgId
                                ? {
                                    ...m,
                                    content: accumulated,
                                    streaming: false,
                                    tokens,
                                    traceId: evt.traceId ?? m.traceId,
                                    assistantId: evt.assistantId ?? m.assistantId,
                                    assistantName: evt.assistantName ?? m.assistantName,
                                }
                                : m
                        ));
                        streamFinished = true;
                        try { reader.cancel(); } catch { /* ignore */ }
                        return;
                    }
                }
            }

            // Stream ended without explicit done: clean up streaming flag
            if (streamingMsgId) {
                setMessages(prev => prev.map(m =>
                    m.id === streamingMsgId ? { ...m, content: accumulated, streaming: false } : m
                ));
            }
            streamFinished = true;
        } catch (streamErr) {
            // Remove the empty streaming bubble if it exists before the fallback
            if (streamingMsgId) {
                setMessages(prev => prev.filter(m => m.id !== streamingMsgId));
                streamingMsgId = null;
            }
            // ── Fallback path: non-stream /chat/send via axios ───────────────
            try {
                const res = await api.post(ENDPOINTS.CHAT_SEND, body);
                const data = res.data;
                if (res.status === 202 && data?.status === 'PENDING_APPROVAL') {
                    setMessages(prev => [...prev, {
                        id: genId(),
                        role: 'error',
                        errorKind: 'hitl_pending',
                        errorReason: data.reason ?? 'Ação de alto risco detectada.',
                        timestamp: Date.now(),
                    }]);
                } else if (data?._govai?.delegated === true && data._govai.workItemId) {
                    appendDelegationMessage(data, assistantSnap);
                } else {
                    appendAssistantResponse(data, assistantSnap);
                }
                streamFinished = true;
            } catch (fallbackErr: any) {
                const { kind, reason, retryAfterSec } = classifyError(fallbackErr);
                setMessages(prev => [...prev, {
                    id: genId(),
                    role: 'error',
                    errorKind: kind,
                    errorReason: reason,
                    retryAfterSec,
                    timestamp: Date.now(),
                }]);
                streamFinished = true;
            }
            // Suppress unused variable lint
            void streamErr;
        } finally {
            void streamFinished;
            setSending(false);
            inputRef.current?.focus();
        }
    }, [
        input, sending, selectedAssistantId, sessionId, selectedModelId, forceDelegate,
        assistants, appendAssistantResponse, appendDelegationMessage, appendErrorFromPayload,
    ]);

    // ── Approval handler ─────────────────────────────────────────────────────
    // FASE 6c: `mode` lets the user opt into bulk approval for the entire work
    // item. The backend persists the mode into execution_context.approval_mode
    // and the adapter's action_required handler reads it on every subsequent
    // tool call to decide whether to auto-allow.
    const handleApproval = useCallback(async (
        workItemId: string,
        promptId: string,
        approved: boolean,
        mode: ApproveMode = 'single'
    ) => {
        try {
            await api.post(ENDPOINTS.ARCHITECT_WORK_ITEM_APPROVE_ACTION(workItemId), {
                prompt_id: promptId,
                approved,
                approve_mode: mode,
            });
            setDelegationStates(prev => ({
                ...prev,
                [workItemId]: prev[workItemId]
                    ? {
                        ...prev[workItemId],
                        pendingApproval: null,
                        status: 'in_progress',
                        approvalMode: (approved && mode !== 'single')
                            ? mode
                            : prev[workItemId].approvalMode,
                    }
                    : prev[workItemId],
            }));
        } catch {
            // keep the approval banner; user can retry
        }
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    // ── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="flex-1 flex min-h-0 min-w-0 relative">
            {/* Mobile sidebar backdrop */}
            {sidebarOpen && (
                <div
                    className="lg:hidden fixed inset-0 z-30 bg-background/70 backdrop-blur-sm"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside
                className={`
                    w-72 shrink-0 border-r border-border/60 bg-card/40 flex flex-col min-h-0
                    lg:static lg:translate-x-0
                    fixed inset-y-0 left-0 z-40 transition-transform duration-200
                    ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
                `}
            >
                <div className="px-5 py-5 border-b border-border/60 flex items-center justify-between">
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                            GovAI
                        </div>
                        <div className="text-lg font-semibold tracking-tight text-foreground">
                            Chat Governado
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setSidebarOpen(false)}
                        className="lg:hidden p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
                    {/* Assistants */}
                    <section>
                        <div className="px-2 mb-2 flex items-center justify-between">
                            <h3 className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                                Assistentes
                            </h3>
                            {loadingInit && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                        </div>
                        <div className="space-y-1">
                            {assistants.length === 0 && !loadingInit && (
                                <div className="px-2 text-xs text-muted-foreground italic">Nenhum assistente publicado.</div>
                            )}
                            {assistants.map(a => {
                                const active = a.id === selectedAssistantId;
                                return (
                                    <button
                                        key={a.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedAssistantId(a.id);
                                            setSidebarOpen(false);
                                        }}
                                        className={`w-full text-left px-3 py-2.5 rounded-md border transition-colors ${
                                            active
                                                ? 'bg-primary/10 border-primary/30 text-foreground'
                                                : 'border-transparent hover:bg-accent hover:border-border/60 text-foreground/80'
                                        }`}
                                    >
                                        <div className="flex items-start gap-2">
                                            <Bot className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-medium truncate">{a.name}</div>
                                                <div className="flex items-center gap-1.5 mt-0.5 text-[10px]">
                                                    {a.delegation_enabled && (
                                                        <span className="inline-flex items-center gap-0.5 text-primary">
                                                            <Zap className="w-2.5 h-2.5" /> delegação
                                                        </span>
                                                    )}
                                                    {a.skill_count > 0 && (
                                                        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                                                            <Sparkles className="w-2.5 h-2.5" /> {a.skill_count} skills
                                                        </span>
                                                    )}
                                                    {a.lifecycle_state === 'draft' && (
                                                        <span className="uppercase tracking-wider text-muted-foreground">rascunho</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    {/* Model selector */}
                    <section>
                        <h3 className="px-2 mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                            Modelo
                        </h3>
                        <div className="relative">
                            <select
                                value={selectedModelId ?? ''}
                                onChange={e => setSelectedModelId(e.target.value || null)}
                                className="w-full appearance-none bg-muted/40 border border-border/60 rounded-md pl-3 pr-8 py-2 text-sm text-foreground focus:outline-none focus:border-primary/60 transition-colors"
                            >
                                {models.map(m => (
                                    <option key={m.id} value={m.id}>
                                        {m.name}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                        </div>
                        {selectedModel && (
                            <div className="mt-1.5 px-2 text-[10px] text-muted-foreground font-mono">
                                {selectedModel.provider}
                            </div>
                        )}
                    </section>

                    {/* Recent sessions */}
                    <section>
                        <h3 className="px-2 mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                            Sessões recentes
                        </h3>
                        <div className="space-y-1">
                            {sessions.length === 0 && (
                                <div className="px-2 text-xs text-muted-foreground italic">Nenhuma sessão.</div>
                            )}
                            {sessions.slice(0, 8).map(s => (
                                <div
                                    key={s.session_id}
                                    className="px-2.5 py-1.5 rounded-md text-xs text-muted-foreground flex items-center gap-2 hover:bg-accent hover:text-foreground transition-colors cursor-default"
                                    title={new Date(s.last_at).toLocaleString('pt-BR')}
                                >
                                    <History className="w-3 h-3 shrink-0" />
                                    <span className="truncate flex-1">{s.assistant_name ?? 'Sessão'}</span>
                                    {s.has_delegation && <Zap className="w-2.5 h-2.5 text-primary shrink-0" />}
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* Governance footer */}
                    <section className="px-2 pt-4 border-t border-border/50">
                        <div className="flex items-start gap-2 text-[11px] text-muted-foreground leading-relaxed">
                            <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0 mt-px" />
                            <span>
                                Toda mensagem passa pelo pipeline de governança:
                                política, DLP, cota, trilha de auditoria.
                            </span>
                        </div>
                    </section>
                </div>
            </aside>

            {/* Main chat column */}
            <main className="flex-1 flex flex-col min-w-0 min-h-0">

                {/* Header */}
                <header className="h-14 border-b border-border/60 flex items-center gap-3 px-4 lg:px-6 shrink-0 bg-card/30">
                    <button
                        type="button"
                        onClick={() => setSidebarOpen(v => !v)}
                        className="lg:hidden p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    {selectedAssistant ? (
                        <>
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="w-8 h-8 rounded-md bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
                                    <Bot className="w-4 h-4 text-primary" />
                                </div>
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold text-foreground truncate leading-tight">
                                        {selectedAssistant.name}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                                        {selectedAssistant.lifecycle_state}
                                    </div>
                                </div>
                            </div>
                            <div className="flex-1" />
                            {selectedModel && (
                                <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                                    {selectedModel.name}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <MessageSquareText className="w-4 h-4 text-muted-foreground" />
                            <div className="text-sm font-medium text-foreground">Chat Governado</div>
                            <div className="flex-1" />
                        </>
                    )}
                </header>

                {/* Multi-agent summary bar — only when >1 assistant answered in this session */}
                {(() => {
                    const pairs = messages
                        .filter(m => (m.role === 'assistant' || m.role === 'delegation' || m.role === 'delegation_result') && m.assistantId)
                        .map(m => [m.assistantId!, m.assistantName ?? 'Assistente'] as const);
                    const seen = new Map<string, string>();
                    for (const [id, name] of pairs) if (!seen.has(id)) seen.set(id, name);
                    if (seen.size <= 1) return null;
                    return (
                        <div className="shrink-0 border-b border-border/40 bg-card/20 px-4 lg:px-8 py-2 flex items-center gap-2 overflow-x-auto">
                            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold shrink-0">
                                {seen.size} especialistas
                            </span>
                            <div className="flex items-center gap-1.5">
                                {Array.from(seen.entries()).map(([id, name]) => (
                                    <span
                                        key={id}
                                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/40 border border-border/60 text-[11px] text-foreground/80"
                                    >
                                        <AssistantAvatar name={name} id={id} size={16} />
                                        {name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    );
                })()}

                {/* Messages */}
                <div
                    ref={messagesContainerRef}
                    onScroll={handleMessagesScroll}
                    className="flex-1 overflow-y-auto min-h-0 relative"
                >
                    <div className="max-w-3xl mx-auto px-4 lg:px-8 py-8">
                        {messages.length === 0 ? (
                            <EmptyState
                                assistant={selectedAssistant}
                                onSuggestion={(s) => {
                                    setInput(s);
                                    setTimeout(() => inputRef.current?.focus(), 0);
                                }}
                            />
                        ) : (
                            <div className="space-y-8">
                                {messages.map((msg, idx) => {
                                    // FASE 6b multi-agent divider — draw when the assistant
                                    // author of this message is different from the previous
                                    // non-user, non-error one.
                                    let prevAuthor: string | undefined;
                                    for (let j = idx - 1; j >= 0; j--) {
                                        const p = messages[j];
                                        if (p.role === 'user' || p.role === 'error') continue;
                                        if (p.assistantId) { prevAuthor = p.assistantId; break; }
                                    }
                                    const showDivider =
                                        (msg.role === 'assistant' || msg.role === 'delegation' || msg.role === 'delegation_result')
                                        && !!msg.assistantId
                                        && !!prevAuthor
                                        && prevAuthor !== msg.assistantId;

                                    return (
                                        <div key={msg.id}>
                                            {showDivider && (
                                                <div className="flex items-center gap-3 -mt-2 mb-4">
                                                    <div className="flex-1 border-t border-border/40" />
                                                    <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground whitespace-nowrap font-semibold">
                                                        {msg.assistantName ?? 'Assistente'} entrou
                                                    </span>
                                                    <div className="flex-1 border-t border-border/40" />
                                                </div>
                                            )}
                                            <MessageRow
                                                msg={msg}
                                                delegationState={msg.workItemId ? delegationStates[msg.workItemId] : undefined}
                                                onApprove={handleApproval}
                                            />
                                        </div>
                                    );
                                })}
                                {sending && !messages.some(m => m.streaming) && (
                                    <div className="pt-1">
                                        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 font-semibold">
                                            {selectedAssistant?.name ?? 'Assistente'}
                                        </div>
                                        <TypingIndicator />
                                    </div>
                                )}
                                <div ref={messagesEndRef} />
                            </div>
                        )}
                    </div>

                    {/* Smart-scroll badge */}
                    {isScrolledUp && messages.length > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
                                setIsScrolledUp(false);
                            }}
                            className="absolute bottom-4 right-4 lg:right-8 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-semibold shadow-lg hover:bg-primary/90 transition-colors"
                        >
                            ↓ Nova mensagem
                        </button>
                    )}
                </div>

                {/* Input bar */}
                <div className="border-t border-border/60 bg-card/20 shrink-0">
                    <div className="max-w-3xl mx-auto px-4 lg:px-8 py-4">
                        <div className={`
                            relative rounded-xl border bg-card/70 transition-colors
                            ${selectedAssistant
                                ? 'border-border/80 focus-within:border-primary/60'
                                : 'border-border/40 opacity-60'}
                        `}>
                            <textarea
                                ref={inputRef}
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                disabled={!selectedAssistant || sending}
                                rows={1}
                                placeholder={
                                    selectedAssistant
                                        ? `Mensagem para ${selectedAssistant.name}…`
                                        : 'Selecione um assistente para começar…'
                                }
                                className="w-full bg-transparent resize-none px-4 pt-3.5 pb-12 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                                style={{ minHeight: '56px', maxHeight: '220px' }}
                            />
                            <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setForceDelegate(v => !v)}
                                        disabled={!selectedAssistant?.delegation_enabled}
                                        title={
                                            selectedAssistant?.delegation_enabled
                                                ? 'Forçar execução autônoma via OpenClaude'
                                                : 'Delegação não habilitada para este assistente'
                                        }
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                                            forceDelegate
                                                ? 'bg-primary/15 text-primary border border-primary/30'
                                                : 'text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent'
                                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                                    >
                                        <Zap className="w-3 h-3" />
                                        Autônomo
                                    </button>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleSend}
                                    disabled={!selectedAssistant || !input.trim() || sending}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {sending ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                        <Send className="w-3 h-3" />
                                    )}
                                    Enviar
                                </button>
                            </div>
                        </div>
                        <div className="flex items-center justify-between mt-2 px-1 text-[10px] text-muted-foreground font-mono">
                            <span>⏎ enviar · ⇧⏎ nova linha</span>
                            <span className="flex items-center gap-1.5">
                                <Shield className="w-2.5 h-2.5" />
                                governança ativa
                            </span>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Empty state
// ═══════════════════════════════════════════════════════════════════════════

function EmptyState({
    assistant, onSuggestion,
}: {
    assistant: Assistant | null;
    onSuggestion: (s: string) => void;
}) {
    if (!assistant) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
                <div className="w-14 h-14 rounded-xl bg-card border border-border/80 flex items-center justify-center mb-6">
                    <Shield className="w-6 h-6 text-primary" />
                </div>
                <h1 className="text-2xl lg:text-3xl font-semibold tracking-tight text-foreground mb-2">
                    Selecione um assistente
                </h1>
                <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
                    Cada assistente tem sua própria política, base de conhecimento e
                    conjunto de ferramentas. Toda conversa aqui passa pelo pipeline
                    completo de governança.
                </p>
                <div className="mt-8 flex items-center gap-6 text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                    <span className="flex items-center gap-1.5">
                        <Shield className="w-3 h-3 text-primary" /> DLP
                    </span>
                    <span className="flex items-center gap-1.5">
                        <ShieldCheck className="w-3 h-3 text-primary" /> Política
                    </span>
                    <span className="flex items-center gap-1.5">
                        <Zap className="w-3 h-3 text-primary" /> Delegação
                    </span>
                </div>
            </div>
        );
    }

    const suggestions = getSuggestions(assistant.name);
    return (
        <div className="flex flex-col min-h-[60vh] pt-10">
            <div className="mb-10">
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold mb-3">
                    Assistente ativo
                </div>
                <h1 className="text-3xl lg:text-4xl font-semibold tracking-tight text-foreground mb-3">
                    {assistant.name}
                </h1>
                {assistant.description && (
                    <p className="text-[15px] text-muted-foreground leading-relaxed max-w-2xl">
                        {assistant.description}
                    </p>
                )}
                <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground font-mono">
                    {assistant.delegation_enabled && (
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 text-primary border border-primary/25">
                            <Zap className="w-3 h-3" /> delegação habilitada
                        </span>
                    )}
                    {assistant.skill_count > 0 && (
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-card border border-border/60">
                            <Sparkles className="w-3 h-3 text-muted-foreground" /> {assistant.skill_count} skills aplicadas
                        </span>
                    )}
                    {assistant.risk_level && (
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-card border border-border/60 uppercase tracking-wider">
                            risco {assistant.risk_level}
                        </span>
                    )}
                </div>
            </div>

            <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold mb-3">
                    Comece por uma destas
                </div>
                <div className="grid gap-2.5">
                    {suggestions.map((s, i) => (
                        <button
                            key={i}
                            type="button"
                            onClick={() => onSuggestion(s)}
                            className="group flex items-start gap-3 text-left px-4 py-3 rounded-lg bg-card/60 border border-border/60 hover:border-primary/30 hover:bg-card transition-colors"
                        >
                            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary mt-0.5 shrink-0 transition-colors" />
                            <span className="text-sm text-foreground/90 group-hover:text-foreground">
                                {s}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Message row
// ═══════════════════════════════════════════════════════════════════════════

function MessageRow({
    msg, delegationState, onApprove,
}: {
    msg: ChatMessage;
    delegationState?: DelegationState;
    onApprove: (workItemId: string, promptId: string, approved: boolean, mode?: ApproveMode) => void;
}) {
    if (msg.role === 'user') {
        return (
            <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 font-semibold text-right">
                    Você
                </div>
                <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-xl bg-primary/10 border border-primary/20 px-4 py-3 text-[15px] text-foreground whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                    </div>
                </div>
            </div>
        );
    }

    if (msg.role === 'assistant') {
        return (
            <div className="group">
                <div className="flex items-center gap-2 mb-2">
                    <AssistantAvatar name={msg.assistantName ?? 'Assistente'} id={msg.assistantId ?? ''} size={22} />
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                        {msg.assistantName ?? 'Assistente'}
                    </div>
                </div>
                <div className="relative pl-8">
                    <Markdown content={msg.content ?? ''} />
                    {msg.streaming && (
                        <span
                            className="inline-block align-baseline w-[2px] h-4 bg-foreground/70 ml-0.5 -mb-0.5"
                            style={{ animation: 'typing-bounce 1.1s ease-in-out infinite' }}
                        />
                    )}
                    <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <CopyButton text={msg.content ?? ''} />
                    </div>
                </div>
                {!msg.streaming && <GovernanceFooter tokens={msg.tokens} traceId={msg.traceId} />}
            </div>
        );
    }

    if (msg.role === 'delegation') {
        return (
            <DelegationCard
                msg={msg}
                state={delegationState}
                onApprove={onApprove}
            />
        );
    }

    if (msg.role === 'delegation_result') {
        return (
            <div>
                <div className="flex items-center gap-2 mb-2">
                    {msg.assistantId && (
                        <AssistantAvatar name={msg.assistantName ?? 'Assistente'} id={msg.assistantId} size={22} />
                    )}
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold flex items-center gap-2">
                        <Zap className="w-3 h-3 text-primary" />
                        Resultado da execução
                    </div>
                </div>
                <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 ml-8">
                    <Markdown content={msg.content ?? ''} />
                </div>
                {msg.tokens && (
                    <div className="ml-8 mt-2 flex gap-3 text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                        {msg.tokens.prompt !== undefined && <span>in {msg.tokens.prompt}</span>}
                        {msg.tokens.completion !== undefined && <span>out {msg.tokens.completion}</span>}
                    </div>
                )}
            </div>
        );
    }

    if (msg.role === 'error') {
        return <ErrorCard msg={msg} />;
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Delegation card + timeline
// ═══════════════════════════════════════════════════════════════════════════

function DelegationCard({
    msg, state, onApprove,
}: {
    msg: ChatMessage;
    state: DelegationState | undefined;
    onApprove: (workItemId: string, promptId: string, approved: boolean, mode?: ApproveMode) => void;
}) {
    const status = state?.status ?? 'pending';
    const isTerminal = ['done', 'cancelled', 'blocked'].includes(status);
    const workItemId = msg.workItemId!;

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                {msg.assistantId && (
                    <AssistantAvatar name={msg.assistantName ?? 'Assistente'} id={msg.assistantId} size={22} />
                )}
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold flex items-center gap-2">
                    <Zap className="w-3 h-3 text-primary" />
                    Delegação autônoma
                    {msg.assistantName && <span className="text-muted-foreground/70">· {msg.assistantName}</span>}
                </div>
            </div>
            <div className="rounded-xl border border-border bg-card">
                <div className="px-4 py-3 border-b border-border/60 flex items-center gap-3">
                    <div className="flex items-center gap-1.5 text-xs font-mono">
                        {!isTerminal && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
                        {status === 'done' && <Check className="w-3 h-3 text-primary" />}
                        {status === 'blocked' && <Ban className="w-3 h-3 text-destructive" />}
                        {status === 'cancelled' && <PauseCircle className="w-3 h-3 text-muted-foreground" />}
                        <span className="uppercase tracking-wider text-foreground">{status}</span>
                    </div>
                    <div className="flex-1" />
                    <div className="text-[10px] font-mono text-muted-foreground truncate max-w-[50%]">
                        {workItemId.slice(0, 8)}
                    </div>
                </div>

                {msg.matchedPattern && (
                    <div className="px-4 py-2 border-b border-border/60 text-[11px] text-muted-foreground">
                        Padrão detectado: <code className="font-mono text-foreground/80">{msg.matchedPattern}</code>
                    </div>
                )}

                <div className="px-4 py-3">
                    <EventTimeline state={state ?? {
                        work_item_id: workItemId,
                        status, events: [], pendingApproval: null, fullText: null, tokens: null, toolCount: 0, approvalMode: null,
                    }} />
                    {/* FASE 6c: tool counter — how many were approved vs executed so far */}
                    {state?.events && state.events.length > 0 && (() => {
                        const approved = state.events.filter(e => e.type === 'ACTION_RESPONSE').length;
                        const executed = state.events.filter(e => e.type === 'TOOL_RESULT').length;
                        if (approved === 0 && executed === 0) return null;
                        return (
                            <div className="mt-2 pt-2 border-t border-border/30 flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                                {approved > 0 && <span>{approved} aprovadas</span>}
                                {executed > 0 && <span>· {executed} executadas</span>}
                            </div>
                        );
                    })()}
                    {/* FASE 6c: "auto-approval active" badge */}
                    {state?.approvalMode === 'auto_all' && state.status !== 'done' && (
                        <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-primary">
                            <Zap className="w-2.5 h-2.5" />
                            Aprovação automática ativa para esta tarefa
                        </div>
                    )}
                    {state?.approvalMode === 'auto_safe' && state.status !== 'done' && (
                        <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-primary">
                            <Zap className="w-2.5 h-2.5" />
                            Leituras auto-aprovadas (escritas ainda pedem permissão)
                        </div>
                    )}
                </div>

                {state?.pendingApproval && (
                    <div className="px-4 py-3 border-t border-border/60 bg-muted/30">
                        <div className="flex items-start gap-2 mb-3">
                            <AlertCircle className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-foreground">
                                    Ferramenta requer aprovação
                                </div>
                                <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
                                    {state.pendingApproval.tool_name}
                                </div>
                                {state.pendingApproval.question && (
                                    <div className="text-[11px] text-muted-foreground italic mt-1">
                                        &quot;{state.pendingApproval.question}&quot;
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <button
                                type="button"
                                onClick={() => onApprove(workItemId, state.pendingApproval!.prompt_id, true, 'single')}
                                className="px-3 py-1 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                            >
                                Aprovar
                            </button>
                            <button
                                type="button"
                                onClick={() => onApprove(workItemId, state.pendingApproval!.prompt_id, false, 'single')}
                                className="px-3 py-1 text-xs font-semibold rounded-md bg-destructive/80 text-destructive-foreground hover:bg-destructive transition-colors"
                            >
                                Negar
                            </button>
                            <button
                                type="button"
                                onClick={() => onApprove(workItemId, state.pendingApproval!.prompt_id, true, 'auto_all')}
                                title="Aprova esta e todas as ferramentas seguintes desta tarefa, sem pedir confirmação de novo."
                                className="px-3 py-1 text-xs font-semibold rounded-md bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors inline-flex items-center gap-1"
                            >
                                <Zap className="w-3 h-3" />
                                Aprovar Todos
                            </button>
                        </div>
                        <div className="mt-2 text-[10px] text-muted-foreground/70">
                            Esta decisão é registrada em <code className="font-mono">evidence_records</code> (trilha de auditoria governada).
                        </div>
                    </div>
                )}

                {status === 'blocked' && (
                    <div className="px-4 py-3 border-t border-border/60 bg-destructive/5 text-[11px] text-destructive">
                        Execução bloqueada após tentativas de dispatch.
                    </div>
                )}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Governance footer
// ═══════════════════════════════════════════════════════════════════════════

function GovernanceFooter({
    tokens, traceId,
}: {
    tokens?: { prompt?: number; completion?: number } | null;
    traceId?: string;
}) {
    return (
        <div className="mt-3 flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            <span className="flex items-center gap-1">
                <Shield className="w-2.5 h-2.5 text-primary" />
                governado
            </span>
            {tokens?.prompt !== undefined && (
                <span>in {tokens.prompt}</span>
            )}
            {tokens?.completion !== undefined && (
                <span>out {tokens.completion}</span>
            )}
            {traceId && (
                <span className="truncate max-w-[180px]" title={traceId}>
                    {String(traceId).slice(0, 8)}
                </span>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Error card
// ═══════════════════════════════════════════════════════════════════════════

function ErrorCard({ msg }: { msg: ChatMessage }) {
    const [countdown, setCountdown] = useState(msg.retryAfterSec ?? 0);

    useEffect(() => {
        if (msg.errorKind !== 'rate_limit' || !msg.retryAfterSec) return;
        const t = setInterval(() => {
            setCountdown(prev => (prev > 0 ? prev - 1 : 0));
        }, 1000);
        return () => clearInterval(t);
    }, [msg.errorKind, msg.retryAfterSec]);

    const meta = (() => {
        switch (msg.errorKind) {
            case 'rate_limit':
                return { icon: Clock, label: 'Limite de requisições', tone: 'border-border bg-card' };
            case 'policy_block':
                return { icon: Ban, label: 'Política violada', tone: 'border-destructive/30 bg-destructive/5' };
            case 'dlp_block':
                return { icon: FileWarning, label: 'DLP bloqueou', tone: 'border-destructive/30 bg-destructive/5' };
            case 'quota_exceeded':
                return { icon: AlertTriangle, label: 'Cota excedida', tone: 'border-destructive/30 bg-destructive/5' };
            case 'service_unavailable':
                return { icon: WifiOff, label: 'Serviço indisponível', tone: 'border-border bg-card' };
            case 'hitl_pending':
                return { icon: ShieldAlert, label: 'Aguardando aprovação humana', tone: 'border-border bg-card' };
            default:
                return { icon: AlertCircle, label: 'Erro', tone: 'border-destructive/30 bg-destructive/5' };
        }
    })();
    const Icon = meta.icon;

    return (
        <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 font-semibold">
                Sistema
            </div>
            <div className={`rounded-xl border px-4 py-3 ${meta.tone}`}>
                <div className="flex items-start gap-3">
                    <Icon className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-foreground uppercase tracking-wider mb-1">
                            {meta.label}
                        </div>
                        <div className="text-[13px] text-foreground/90 leading-relaxed">
                            {msg.errorReason}
                        </div>
                        {msg.errorKind === 'rate_limit' && countdown > 0 && (
                            <div className="mt-2 text-[11px] text-muted-foreground font-mono">
                                Tente novamente em {countdown}s
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
