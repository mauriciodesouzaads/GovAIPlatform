'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    Loader2, MessageSquare, Edit2, Check, AlertTriangle,
    Terminal, ExternalLink, Download, FileText, FileImage,
    FileCode, FileArchive, FileSpreadsheet, File as FileIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useChatClient } from '../_components/use-chat-client';
import { ChatMarkdown } from '../_components/ChatMarkdown';
import { ChatInput } from '../_components/ChatInput';
import { ModelSelector } from '../_components/ModelSelector';
import { TimelineView } from '@/components/execucoes/timeline-view';
import type {
    ChatClient, ChatMessage, Conversation, CodeRuntimeEvent,
    WorkItemFile,
} from '@/lib/chat-client';
import type { RuntimeWorkItemEvent } from '@/types/runtime-admin';

type TurnMode = 'chat' | 'code';

interface UIMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    pending?: boolean;
    error?: string;
    tokens?: { in?: number | null; out?: number | null };
    latency_ms?: number | null;
    model?: string | null;
    // 6c.B: discriminador do turn — 'chat' (delta) vs 'code' (timeline).
    mode?: TurnMode | 'cowork';
    work_item_id?: string | null;
    // Eventos coletados durante o stream em mode='code'. Para mensagens
    // históricas vindas do GET /messages essa lista fica vazia — UI
    // renderiza apenas a resposta final + link "Ver detalhes técnicos".
    code_events?: CodeRuntimeEvent[];
    // Metadata persistida (ex: { tool_count: 3 }) — útil para
    // mensagens históricas em mode='code' onde não temos os eventos.
    metadata?: Record<string, unknown> | null;
    // 6c.B.1: arquivos gerados no workspace, populados após RUN_COMPLETED
    // via listWorkItemFiles. Para mensagens históricas, lazy-load no mount.
    outputs?: WorkItemFile[];
}

export default function ChatConversationPage() {
    const client = useChatClient();
    const router = useRouter();
    const params = useParams();
    const id = (params?.id as string | undefined) ?? '';

    const [conv, setConv] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<UIMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [streaming, setStreaming] = useState(false);
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    // 6c.B: modo do próximo turn. 'chat' = LiteLLM passthrough (default),
    // 'code' = dispatchWorkItem com Claude Code SDK nativo. Persistido
    // só no client; cada turn carrega o mode escolhido no momento do
    // submit. Conversas podem alternar entre turns chat e code livremente.
    const [turnMode, setTurnMode] = useState<TurnMode>('chat');

    const scrollRef = useRef<HTMLDivElement>(null);

    // Load conversation + history.
    useEffect(() => {
        if (!client || !id) return;
        let cancelled = false;
        const ctrl = new AbortController();
        (async () => {
            try {
                const [c, msgs] = await Promise.all([
                    client.getConversation(id, ctrl.signal),
                    client.listMessages(id, ctrl.signal),
                ]);
                if (cancelled) return;
                setConv(c);
                const ui = msgs.map(toUIMessage);
                setMessages(ui);
                // 6c.B.1: lazy-load outputs para mensagens code históricas.
                // Disparamos em paralelo (não bloqueia o paint inicial); cada
                // resultado dispara um setMessages individual. Mensagens sem
                // arquivos não geram update.
                ui.filter(m => m.role === 'assistant' && m.mode === 'code' && m.work_item_id)
                    .forEach(m => {
                        loadOutputs(client, m.work_item_id!, m.id, setMessages);
                    });
            } catch (err) {
                if ((err as Error).name === 'AbortError') return;
                if ((err as Error).message.includes('not found')) {
                    toast.error('Conversa não encontrada');
                    router.replace('/chat');
                    return;
                }
                console.error('[chat conv]', err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; ctrl.abort(); };
    }, [client, id, router]);

    // Auto-scroll to bottom when messages or streaming state change.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages, streaming]);

    async function send(
        content: string,
        attachmentIds: string[],
        mode: TurnMode = turnMode,
    ) {
        if (!client || !conv) return;
        const userMsg: UIMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content,
        };
        const assistantMsg: UIMessage = {
            id: `asst-${Date.now()}`,
            role: 'assistant',
            content: '',
            pending: true,
            model: conv.default_model,
            mode,
            code_events: mode === 'code' ? [] : undefined,
        };
        setMessages(prev => [...prev, userMsg, assistantMsg]);
        setStreaming(true);

        try {
            for await (const env of client.sendMessage(id, {
                content,
                model: conv.default_model,
                attachments_ids: attachmentIds,
                mode,
            })) {
                if (env.type === 'delta') {
                    setMessages(prev => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant') {
                            next[next.length - 1] = { ...last, content: last.content + env.content };
                        }
                        return next;
                    });
                } else if (env.type === 'mode_code_started') {
                    // 6c.B: backend confirmou que o turn entrou no
                    // pipeline de dispatchWorkItem. Anotamos o
                    // work_item_id para o link "Ver detalhes técnicos"
                    // e a renderização passa a usar a TimelineView.
                    setMessages(prev => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant') {
                            next[next.length - 1] = {
                                ...last,
                                work_item_id: env.work_item_id,
                                id: env.message_id,
                            };
                        }
                        return next;
                    });
                } else if (env.type === 'code_event') {
                    // Cada evento do runtime_work_item_events que o
                    // backend forwarda. TimelineView consome.
                    setMessages(prev => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant' && last.mode === 'code') {
                            next[next.length - 1] = {
                                ...last,
                                code_events: [...(last.code_events ?? []), env.event],
                            };
                        }
                        return next;
                    });
                } else if (env.type === 'done') {
                    const wi = env.work_item_id;
                    const newId = env.assistant_message_id;
                    setMessages(prev => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant') {
                            next[next.length - 1] = {
                                ...last,
                                pending: false,
                                tokens: env.tokens,
                                latency_ms: env.latency_ms,
                                id: newId ?? last.id,
                                work_item_id: wi ?? last.work_item_id,
                            };
                        }
                        return next;
                    });
                    // 6c.B.1: após RUN_COMPLETED em mode='code', buscar
                    // arquivos gerados e popular o array msg.outputs. UI
                    // renderiza chips clicáveis abaixo da bubble. Falha
                    // silenciosa: se /files retorna [] ou erro, a seção
                    // simplesmente não aparece.
                    if (wi && mode === 'code') {
                        try {
                            const r = await client.listWorkItemFiles(wi);
                            if (r.files?.length) {
                                setMessages(prev => {
                                    const next = [...prev];
                                    // localiza a msg pelo work_item_id (id pode ter
                                    // sido renomeado pelo `newId` acima neste mesmo turn)
                                    const idx = next.findIndex(
                                        m => m.work_item_id === wi && m.role === 'assistant',
                                    );
                                    if (idx >= 0) {
                                        next[idx] = { ...next[idx], outputs: r.files };
                                    }
                                    return next;
                                });
                            }
                        } catch (err) {
                            console.warn('[chat code] listWorkItemFiles failed:', err);
                        }
                    }
                } else if (env.type === 'error') {
                    setMessages(prev => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant') {
                            next[next.length - 1] = {
                                ...last,
                                pending: false,
                                error: env.error,
                            };
                        }
                        return next;
                    });
                    toast.error(`Erro: ${env.error}`);
                }
            }
        } catch (err) {
            const msg = (err as Error).message;
            setMessages(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === 'assistant') {
                    next[next.length - 1] = { ...last, pending: false, error: msg };
                }
                return next;
            });
            toast.error(msg);
        } finally {
            setStreaming(false);
            // Refresh conversation (auto-title may have changed on first turn).
            try {
                const updated = await client.getConversation(id);
                setConv(updated);
            } catch { /* ignore */ }
        }
    }

    async function saveTitle() {
        if (!client || !conv || !titleDraft.trim()) {
            setEditingTitle(false);
            return;
        }
        try {
            const updated = await client.patchConversation(id, { title: titleDraft.trim() });
            setConv(updated);
            toast.success('Título atualizado');
        } catch (err) {
            toast.error('Falha ao atualizar título');
        }
        setEditingTitle(false);
    }

    async function changeModel(modelId: string) {
        if (!client || !conv) return;
        try {
            const updated = await client.patchConversation(id, { default_model: modelId });
            setConv(updated);
        } catch {
            toast.error('Falha ao trocar modelo');
        }
    }

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
            </div>
        );
    }

    if (!conv) return null;

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-3 border-b border-white/5">
                <div className="flex items-center gap-2.5 min-w-0">
                    {/* 6c.A.1 — avatar emoji do agente quando vinculado */}
                    {conv.assistant_id && conv.assistant_avatar && (
                        <div className="w-8 h-8 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-base flex-shrink-0">
                            {conv.assistant_avatar}
                        </div>
                    )}
                    <div className="flex flex-col min-w-0">
                        {editingTitle ? (
                            <div className="flex items-center gap-1">
                                <input
                                    value={titleDraft}
                                    onChange={e => setTitleDraft(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') saveTitle();
                                        if (e.key === 'Escape') setEditingTitle(false);
                                    }}
                                    autoFocus
                                    className="bg-[#141820] border border-white/10 rounded-md px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/40"
                                />
                                <button
                                    onClick={saveTitle}
                                    className="p-1 text-emerald-400 hover:bg-white/5 rounded"
                                >
                                    <Check className="w-4 h-4" />
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => {
                                    setTitleDraft(conv.title);
                                    setEditingTitle(true);
                                }}
                                className="text-sm font-medium text-zinc-100 hover:bg-white/5 px-1.5 py-0.5 rounded inline-flex items-center gap-1.5 group truncate max-w-[400px] -ml-1.5"
                                title={conv.title}
                            >
                                <span className="truncate">{conv.title}</span>
                                <Edit2 className="w-3 h-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                            </button>
                        )}
                        {conv.assistant_id && conv.assistant_category && (
                            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium px-1.5">
                                Agente · {conv.assistant_category}
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <ModeTabs value={turnMode} onChange={setTurnMode} />
                    <ModelSelector
                        value={conv.default_model}
                        onChange={changeModel}
                        mode={turnMode}
                    />
                </div>
            </header>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-6 py-8">
                    {messages.length === 0 ? (
                        <EmptyState
                            conv={conv}
                            onPromptClick={(p) => {
                                // Permite o usuário enviar diretamente
                                // ou apenas pré-preencher o input — aqui
                                // optamos por enviar imediatamente para
                                // reduzir cliques no fluxo "demo do agente".
                                send(p, []);
                            }}
                        />
                    ) : (
                        <div className="space-y-6">
                            {messages.map(m =>
                                m.role === 'assistant' && m.mode === 'code' ? (
                                    <CodeMessageBubble
                                        key={m.id}
                                        msg={m}
                                        streaming={streaming}
                                    />
                                ) : (
                                    <MessageBubble
                                        key={m.id}
                                        msg={m}
                                        streaming={streaming}
                                    />
                                ),
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Input */}
            <div className="max-w-3xl mx-auto w-full">
                <ChatInput
                    client={client}
                    convId={id}
                    model={conv.default_model}
                    onModelChange={changeModel}
                    onSend={send}
                    disabled={streaming}
                />
            </div>
        </div>
    );
}

function MessageBubble({ msg, streaming }: { msg: UIMessage; streaming: boolean }) {
    if (msg.role === 'user') {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-[#252A38] px-4 py-2.5 text-sm text-zinc-100 whitespace-pre-wrap leading-relaxed">
                    {msg.content}
                </div>
            </div>
        );
    }
    // assistant
    const showCursor = msg.pending && streaming && !msg.error;
    return (
        <div className="flex gap-3">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-xs">
                ✦
            </div>
            <div className="flex-1 min-w-0">
                {msg.error ? (
                    <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200 flex items-start gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        <span>{msg.error}</span>
                    </div>
                ) : msg.content ? (
                    <>
                        <ChatMarkdown content={msg.content} />
                        {showCursor && (
                            <span className="inline-block w-1.5 h-4 bg-emerald-400 align-middle animate-pulse ml-1" />
                        )}
                    </>
                ) : (
                    <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
                )}
                {(msg.tokens || msg.latency_ms) && !msg.pending && (
                    <div className="mt-2 text-[10px] text-zinc-600 flex items-center gap-3">
                        {msg.model && <span>{msg.model}</span>}
                        {msg.tokens?.in != null && (
                            <span>{msg.tokens.in} → {msg.tokens.out ?? 0} tokens</span>
                        )}
                        {msg.latency_ms != null && (
                            <span>{(msg.latency_ms / 1000).toFixed(2)}s</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Empty state — duas variantes:
 *   - Conversa livre: ícone genérico + saudação simples
 *   - Conversa vinculada a agente: avatar grande do agente + saudação
 *     personalizada + chips clicáveis com suggested_prompts. Cada chip
 *     dispara onSend imediato para reduzir fricção no demo "Catálogo →
 *     Usar agente → Pergunta funcionando".
 */
function EmptyState({
    conv,
    onPromptClick,
}: {
    conv: Conversation;
    onPromptClick: (prompt: string) => void;
}) {
    const hasAgent = Boolean(conv.assistant_id);
    const suggestions = conv.assistant_suggested_prompts ?? [];

    if (hasAgent) {
        return (
            <div className="text-center py-12 space-y-5">
                <div className="mx-auto w-16 h-16 rounded-3xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-3xl">
                    {conv.assistant_avatar ?? '✦'}
                </div>
                <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-zinc-100">
                        Olá. Sou {conv.assistant_name ?? conv.title}.
                    </h2>
                    {conv.assistant_description && (
                        <p className="text-sm text-zinc-400 max-w-xl mx-auto leading-relaxed">
                            {conv.assistant_description}
                        </p>
                    )}
                </div>
                {suggestions.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-2xl mx-auto pt-2">
                        {suggestions.map((p, i) => (
                            <button
                                key={i}
                                onClick={() => onPromptClick(p)}
                                className="text-left text-sm text-zinc-300 bg-[#141820] border border-white/10 rounded-lg px-3 py-2.5 hover:bg-[#1a1f2a] hover:border-emerald-500/30 transition-colors"
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                )}
                <p className="text-[11px] text-zinc-600 pt-2">
                    Esta conversa é auditada e passa por DLP. Mude o modelo no canto superior direito.
                </p>
            </div>
        );
    }

    return (
        <div className="text-center py-16 space-y-3">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                <MessageSquare className="w-6 h-6 text-emerald-400" />
            </div>
            <h2 className="text-base font-semibold text-zinc-100">O que vamos resolver hoje?</h2>
            <p className="text-sm text-zinc-500 max-w-md mx-auto">
                Pergunte qualquer coisa. Esta conversa é auditada e passa por DLP.
                Mude o modelo a qualquer momento no canto superior direito.
            </p>
        </div>
    );
}

function toUIMessage(m: ChatMessage): UIMessage {
    return {
        id: m.id,
        role: m.role,
        content: m.content,
        model: m.model,
        tokens: { in: m.tokens_in, out: m.tokens_out },
        latency_ms: m.latency_ms,
        mode: m.mode,
        work_item_id: m.work_item_id ?? null,
        metadata: m.metadata ?? null,
    };
}

// 6c.B.1: helper de lazy-load de outputs para mensagens code históricas.
// Faz fire-and-forget; se /files retorna vazio ou der erro, simplesmente
// não atualiza o estado (a seção "Arquivos gerados" só aparece quando há
// pelo menos 1 arquivo).
function loadOutputs(
    client: ChatClient,
    workItemId: string,
    msgId: string,
    setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>,
) {
    client
        .listWorkItemFiles(workItemId)
        .then(r => {
            if (!r.files?.length) return;
            setMessages(prev => {
                const next = [...prev];
                const idx = next.findIndex(m => m.id === msgId);
                if (idx >= 0) next[idx] = { ...next[idx], outputs: r.files };
                return next;
            });
        })
        .catch(() => { /* falha silenciosa — UI degrada graciosamente */ });
}

function fileIconFor(mime: string, filename: string) {
    if (mime.startsWith('image/')) return FileImage;
    if (mime === 'application/pdf') return FileText;
    if (mime.startsWith('text/csv') || filename.endsWith('.csv') || filename.endsWith('.xlsx')) {
        return FileSpreadsheet;
    }
    if (mime.startsWith('text/') || /\.(md|txt|json|yaml|yml|log)$/.test(filename)) {
        return FileText;
    }
    if (/\.(js|ts|jsx|tsx|py|go|rs|java|cpp|c|h)$/.test(filename)) return FileCode;
    if (/\.(zip|tar|gz|7z|rar)$/.test(filename)) return FileArchive;
    return FileIcon;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function OutputChip({
    file,
    workItemId,
}: {
    file: WorkItemFile;
    workItemId: string;
}) {
    const client = useChatClient();
    const [downloading, setDownloading] = useState(false);
    const Icon = fileIconFor(file.mime_type, file.filename);

    async function onDownload() {
        if (!client || downloading) return;
        setDownloading(true);
        try {
            const { blob } = await client.downloadWorkItemFile(workItemId, file.id);
            // Object URL → <a download> trigger → revoke. Padrão fetch-then-save
            // que evita problemas de CORS/auth que <a href> direto teria.
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            toast.error(`Falha ao baixar: ${(err as Error).message}`);
        } finally {
            setDownloading(false);
        }
    }

    return (
        <button
            onClick={onDownload}
            disabled={downloading}
            className={
                'inline-flex items-center gap-2 px-3 py-2 rounded-md ' +
                'border border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 ' +
                'transition-colors text-xs disabled:opacity-50 disabled:cursor-wait'
            }
            title={`Baixar ${file.filename}`}
        >
            <Icon className="w-4 h-4 text-amber-300 flex-shrink-0" />
            <div className="flex flex-col items-start min-w-0">
                <span className="text-zinc-100 font-medium truncate max-w-[180px]">
                    {file.filename}
                </span>
                <span className="text-zinc-500 text-[10px]">
                    {formatBytes(file.size_bytes)}
                </span>
            </div>
            {downloading
                ? <Loader2 className="w-3 h-3 text-amber-400 ml-1 animate-spin" />
                : <Download className="w-3 h-3 text-amber-400 ml-1" />}
        </button>
    );
}

// ── 6c.B: Mode tabs ────────────────────────────────────────────────────────
//
// Pílula compacta com Chat/Code. Posicionada no header do lado direito,
// antes do ModelSelector. O mode escolhido aplica-se ao próximo turn.
function ModeTabs({
    value,
    onChange,
}: {
    value: TurnMode;
    onChange: (v: TurnMode) => void;
}) {
    const tabs: { key: TurnMode; label: string; icon: React.ReactNode }[] = [
        { key: 'chat', label: 'Chat', icon: <MessageSquare className="w-3 h-3" /> },
        { key: 'code', label: 'Code', icon: <Terminal className="w-3 h-3" /> },
    ];
    return (
        <div className="inline-flex items-center gap-0.5 bg-[#141820] border border-white/10 rounded-md p-0.5">
            {tabs.map(t => (
                <button
                    key={t.key}
                    onClick={() => onChange(t.key)}
                    className={
                        'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ' +
                        (value === t.key
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'text-zinc-400 hover:text-zinc-200 border border-transparent')
                    }
                    title={
                        t.key === 'code'
                            ? 'Modo Code — executa via Claude Code SDK com ferramentas (Bash, Read, Write…)'
                            : 'Modo Chat — resposta conversacional do LLM escolhido'
                    }
                >
                    {t.icon}
                    {t.label}
                </button>
            ))}
        </div>
    );
}

// ── 6c.B: Bolha de mensagem em mode='code' ─────────────────────────────────
//
// Layout:
//   1. Avatar Terminal + label "Code"
//   2. Timeline inline com tools, thinking, run lifecycle (TimelineView do
//      módulo /execucoes — mesma renderização que o admin)
//   3. Resposta final em markdown (msg.content)
//   4. Footer: tokens · latency · botão "Ver detalhes técnicos" → /execucoes
//
// Para mensagens históricas (vindas do GET /messages), code_events fica
// vazia — mostramos só a resposta final + tool_count + link.
function CodeMessageBubble({
    msg,
    streaming,
}: {
    msg: UIMessage;
    streaming: boolean;
}) {
    const isLive = (msg.code_events?.length ?? 0) > 0;
    const showCursor = msg.pending && streaming && !msg.error;
    const toolCount =
        (msg.metadata && typeof (msg.metadata as { tool_count?: number }).tool_count === 'number')
            ? (msg.metadata as { tool_count: number }).tool_count
            : null;

    // 6c.B.1 — separar streaming text (MESSAGE_DELTA) dos eventos de
    // ferramentas. A TimelineView só renderiza tools/thinking/run_*; o
    // texto do assistant aparece num bloco markdown logo abaixo, em
    // paralelo. Quando o stream encerra (msg.content já consolidado),
    // descartamos o bloco intermediário e renderizamos só o final.
    const { toolEvents, streamingText } = useMemo(() => {
        const events = msg.code_events ?? [];
        const tools = events.filter(
            e => e.type !== 'MESSAGE_DELTA' && e.type !== 'MESSAGE_BLOCK',
        );
        const text = events
            .filter(e => e.type === 'MESSAGE_DELTA' || e.type === 'MESSAGE_BLOCK')
            .map(e => {
                const p = e.payload as { text?: string } | undefined;
                return typeof p?.text === 'string' ? p.text : '';
            })
            .join('');
        return { toolEvents: tools, streamingText: text };
    }, [msg.code_events]);

    return (
        <div className="flex gap-3">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center">
                <Terminal className="w-3.5 h-3.5 text-amber-300" />
            </div>
            <div className="flex-1 min-w-0 space-y-3">
                <div className="text-[10px] uppercase tracking-wider text-amber-300/80 font-medium">
                    Code · Claude Code SDK
                </div>

                {/* Timeline (apenas durante stream — para histórico fica
                    o link "Ver detalhes técnicos"). Filtra MESSAGE_DELTA
                    p/ não duplicar com o bloco de prosa abaixo. */}
                {isLive && toolEvents.length > 0 && (
                    <div className="rounded-md border border-white/5 bg-[#0E1218] p-3">
                        <TimelineView
                            events={toolEvents as RuntimeWorkItemEvent[]}
                            mode="normal"
                        />
                    </div>
                )}

                {/* Loading inicial — antes do primeiro evento chegar */}
                {!isLive && msg.pending && !msg.content && !msg.error && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Despachando para o runtime…
                    </div>
                )}

                {/* 6c.B.1: texto streaming do assistant (MESSAGE_DELTA
                    acumulado) — aparece em paralelo à timeline durante o
                    stream. Pós-stream, msg.content já carrega o texto
                    consolidado, então preferimos esse e descartamos o
                    streamingText pra evitar duplicação. */}
                {msg.error ? (
                    <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200 flex items-start gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        <span>{msg.error}</span>
                    </div>
                ) : msg.content ? (
                    <div>
                        <ChatMarkdown content={msg.content} />
                        {showCursor && (
                            <span className="inline-block w-1.5 h-4 bg-amber-400 align-middle animate-pulse ml-1" />
                        )}
                    </div>
                ) : streamingText ? (
                    <div className="rounded-md border border-amber-500/10 bg-amber-500/5 px-3 py-2">
                        <ChatMarkdown content={streamingText} />
                        {showCursor && (
                            <span className="inline-block w-1.5 h-4 bg-amber-400 align-middle animate-pulse ml-1" />
                        )}
                    </div>
                ) : null}

                {/* 6c.B.1: outputs (arquivos gerados no workspace).
                    Só renderiza quando há pelo menos 1 arquivo —
                    evita seção vazia. Cada chip é clicável p/ download
                    autenticado via Blob (downloadWorkItemFile). */}
                {(msg.outputs?.length ?? 0) > 0 && msg.work_item_id && (
                    <div className="space-y-2 pt-1">
                        <div className="text-[10px] uppercase tracking-wider text-amber-300/80 font-medium">
                            Arquivos gerados ({msg.outputs!.length})
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {msg.outputs!.map(f => (
                                <OutputChip
                                    key={f.id}
                                    file={f}
                                    workItemId={msg.work_item_id!}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* Footer: tokens · latency · contador de tools · link */}
                {(msg.tokens || msg.latency_ms || msg.work_item_id || toolCount != null) &&
                    !msg.pending && (
                    <div className="text-[10px] text-zinc-600 flex items-center gap-3 flex-wrap">
                        {msg.model && <span>{msg.model}</span>}
                        {msg.tokens?.in != null && (
                            <span>{msg.tokens.in} → {msg.tokens.out ?? 0} tokens</span>
                        )}
                        {msg.latency_ms != null && (
                            <span>{(msg.latency_ms / 1000).toFixed(2)}s</span>
                        )}
                        {toolCount != null && (
                            <span>{toolCount} ferramenta{toolCount === 1 ? '' : 's'}</span>
                        )}
                        {msg.work_item_id && (
                            <a
                                href={`/execucoes/${msg.work_item_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                            >
                                Ver detalhes técnicos
                                <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
