'use client';

import { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';
import { API_BASE } from '@/lib/api';
import {
    Send, Loader2, ShieldCheck, AlertTriangle,
    MessageSquare, Clock, ShieldAlert, Copy, Check,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface AssistantInfo {
    id: string;
    name: string;
    description: string | null;
    lifecycle_state: string;
    policyCount: number;
}

type MessageStatus = 'success' | 'blocked' | 'hitl' | 'error' | 'quota';

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    traceId?: string;
    status?: MessageStatus;
    timestamp: Date;
}

// ── Markdown renderer (lightweight, no external deps) ─────────────────────

function renderMarkdown(text: string): string {
    return text
        // Code blocks
        .replace(/```([\s\S]*?)```/g, '<pre class="bg-secondary/50 border border-border rounded-lg p-3 text-xs font-mono overflow-x-auto my-2 whitespace-pre-wrap"><code>$1</code></pre>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code class="bg-secondary/50 border border-border rounded px-1.5 py-0.5 text-xs font-mono">$1</code>')
        // Bold
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        // Unordered lists
        .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
        // Ordered lists
        .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
        // Wrap consecutive list items
        .replace(/(<li.*<\/li>\n?)+/g, (match) => `<ul class="my-2 space-y-0.5">${match}</ul>`)
        // Line breaks
        .replace(/\n\n/g, '</p><p class="mt-2">')
        .replace(/\n/g, '<br/>');
}

function MessageContent({ content, isAssistant }: { content: string; isAssistant: boolean }) {
    if (!isAssistant) {
        return <span className="text-sm leading-relaxed whitespace-pre-wrap">{content}</span>;
    }
    return (
        <div
            className="text-sm leading-relaxed prose-sm"
            dangerouslySetInnerHTML={{ __html: `<p>${renderMarkdown(content)}</p>` }}
        />
    );
}

// ── Copy button ────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };
    return (
        <button
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground shrink-0"
            title="Copiar mensagem"
            aria-label="Copiar mensagem"
        >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
    );
}

// ── Chat UI ────────────────────────────────────────────────────────────────

function ChatUI({ assistantId }: { assistantId: string }) {
    const searchParams = useSearchParams();

    const [apiKey, setApiKey] = useState('');
    const [keyMissing, setKeyMissing] = useState(false);
    const [assistantInfo, setAssistantInfo] = useState<AssistantInfo | null>(null);
    const [assistantError, setAssistantError] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [loadingInfo, setLoadingInfo] = useState(true);
    const [sessionId] = useState(() =>
        typeof crypto !== 'undefined' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
    );
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Auto-resize textarea
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        const maxHeight = 5 * 24; // 5 lines × approx line height
        el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    }, [input]);

    // Extract API key
    useEffect(() => {
        const urlKey = searchParams.get('key');
        if (urlKey) {
            setApiKey(urlKey);
            if (typeof window !== 'undefined') sessionStorage.setItem('govai_chat_key', urlKey);
        } else {
            const stored = typeof window !== 'undefined' ? sessionStorage.getItem('govai_chat_key') : null;
            if (stored) {
                setApiKey(stored);
            } else {
                setKeyMissing(true);
                setLoadingInfo(false);
            }
        }
    }, [searchParams]);

    const fetchAssistantInfo = useCallback(async (key: string) => {
        try {
            setLoadingInfo(true);
            const res = await axios.get(
                `${API_BASE}/v1/public/assistant/${assistantId}`,
                { headers: { Authorization: `Bearer ${key}` } }
            );
            setAssistantInfo(res.data as AssistantInfo);
        } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } };
            setAssistantError(err.response?.data?.error ?? 'Assistente não encontrado ou não disponível.');
        } finally {
            setLoadingInfo(false);
        }
    }, [assistantId]);

    useEffect(() => {
        if (apiKey) fetchAssistantInfo(apiKey);
    }, [apiKey, fetchAssistantInfo]);

    const sendMessage = async () => {
        if (!input.trim() || loading || !apiKey) return;

        const userMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content: input.trim(),
            timestamp: new Date(),
        };
        setMessages(m => [...m, userMsg]);
        setInput('');
        setLoading(true);

        try {
            const res = await axios.post(
                `${API_BASE}/v1/execute/${assistantId}`,
                { message: userMsg.content, sessionId },
                {
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    validateStatus: () => true,
                }
            );
            const data = res.data as Record<string, unknown>;
            const traceId = (data?.traceId || (data?._govai as Record<string, unknown>)?.traceId) as string | undefined;

            let asstMsg: ChatMessage;
            if (res.status === 200) {
                const content =
                    (((data?.choices as unknown[])?.[0] as Record<string, unknown>)?.message as Record<string, unknown>)?.content as string ||
                    data?.response as string ||
                    JSON.stringify(data, null, 2);
                asstMsg = { id: crypto.randomUUID(), role: 'assistant', content, traceId, status: 'success', timestamp: new Date() };
            } else if (res.status === 202) {
                asstMsg = { id: crypto.randomUUID(), role: 'system', content: 'Esta mensagem requer aprovação humana antes de ser respondida. Aguarde ou entre em contato com o administrador.', traceId, status: 'hitl', timestamp: new Date() };
            } else if (res.status === 403) {
                asstMsg = { id: crypto.randomUUID(), role: 'system', content: 'Esta mensagem não está de acordo com as políticas da organização e foi bloqueada.', traceId, status: 'blocked', timestamp: new Date() };
            } else if (res.status === 429) {
                asstMsg = { id: crypto.randomUUID(), role: 'system', content: 'Limite de uso atingido. Entre em contato com o administrador.', traceId, status: 'quota', timestamp: new Date() };
            } else {
                const reason = (data?.error || data?.details || `HTTP ${res.status}`) as string;
                asstMsg = { id: crypto.randomUUID(), role: 'system', content: `Erro: ${reason}`, traceId, status: 'error', timestamp: new Date() };
            }
            setMessages(m => [...m, asstMsg]);
        } catch (e: unknown) {
            const err = e as { message?: string };
            setMessages(m => [...m, { id: crypto.randomUUID(), role: 'system', content: `Erro de rede: ${err.message || 'Falha ao conectar ao servidor.'}`, status: 'error', timestamp: new Date() }]);
        } finally {
            setLoading(false);
        }
    };

    const formatTime = (d: Date) =>
        d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    // ── Missing key ──────────────────────────────────────────────────────────
    if (keyMissing) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
                <div className="max-w-sm text-center space-y-4">
                    <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto">
                        <AlertTriangle className="w-6 h-6 text-amber-600" />
                    </div>
                    <h1 className="text-lg font-semibold text-gray-900">Chave de acesso não fornecida</h1>
                    <p className="text-sm text-gray-600">Solicite ao administrador da plataforma um link de acesso válido com a chave de API.</p>
                </div>
            </div>
        );
    }

    if (loadingInfo) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
            </div>
        );
    }

    if (assistantError) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
                <div className="max-w-sm text-center space-y-4">
                    <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto">
                        <AlertTriangle className="w-6 h-6 text-red-500" />
                    </div>
                    <h1 className="text-lg font-semibold text-gray-900">Assistente não disponível</h1>
                    <p className="text-sm text-gray-600">{assistantError}</p>
                </div>
            </div>
        );
    }

    // ── Chat ─────────────────────────────────────────────────────────────────
    return (
        <div className="min-h-screen bg-gray-50 flex flex-col">

            {/* Header */}
            <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
                <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center shrink-0">
                    <MessageSquare className="w-4 h-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                    <h1 className="font-semibold text-gray-900 text-sm truncate">
                        {assistantInfo?.name ?? 'GovAI Chat'}
                    </h1>
                    <p className="text-xs text-gray-400">GovAI Platform</p>
                </div>
                <span className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full shrink-0">
                    <ShieldCheck className="w-3 h-3" />
                    {assistantInfo?.policyCount ?? 0} {assistantInfo?.policyCount === 1 ? 'política' : 'políticas'}
                </span>
            </header>

            {/* Governance banner */}
            <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 leading-relaxed">
                    <strong>Esta sessão é monitorada e governada pela política da sua organização.</strong>{' '}
                    Todo acesso é registrado e auditável.
                </p>
            </div>

            {/* Assistant description */}
            {assistantInfo?.description && (
                <div className="bg-white border-b border-gray-100 px-4 py-2">
                    <p className="text-xs text-gray-500 max-w-2xl mx-auto">{assistantInfo.description}</p>
                </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-6 pb-36">
                <div className="max-w-2xl mx-auto space-y-4">

                    {messages.length === 0 && (
                        <div className="text-center py-16 space-y-2">
                            <MessageSquare className="w-8 h-8 text-gray-300 mx-auto" />
                            <p className="text-sm text-gray-400">Envie uma mensagem para começar.</p>
                        </div>
                    )}

                    {messages.map(msg => (
                        <div
                            key={msg.id}
                            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div className="max-w-[85%] space-y-1">

                                {/* Status label for system messages */}
                                {msg.role === 'system' && (
                                    <div className="flex items-center gap-1.5 px-1">
                                        {msg.status === 'hitl' && <Clock className="w-3.5 h-3.5 text-amber-500" />}
                                        {msg.status === 'blocked' && <ShieldAlert className="w-3.5 h-3.5 text-red-500" />}
                                        {(msg.status === 'error' || msg.status === 'quota') && <AlertTriangle className="w-3.5 h-3.5 text-orange-500" />}
                                        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                                            {msg.status === 'hitl' ? 'Aguardando aprovação'
                                                : msg.status === 'blocked' ? 'Bloqueado'
                                                : msg.status === 'quota' ? 'Limite atingido'
                                                : 'Erro'}
                                        </span>
                                    </div>
                                )}

                                {/* Bubble + copy button */}
                                <div className={`group flex items-start gap-1.5 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                                    <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                                        msg.role === 'user'
                                            ? 'bg-emerald-500 text-white rounded-tr-sm'
                                            : msg.status === 'blocked'
                                            ? 'bg-red-50 text-red-800 border border-red-200 rounded-tl-sm'
                                            : msg.status === 'hitl'
                                            ? 'bg-amber-50 text-amber-800 border border-amber-200 rounded-tl-sm'
                                            : msg.status === 'error' || msg.status === 'quota'
                                            ? 'bg-orange-50 text-orange-800 border border-orange-200 rounded-tl-sm'
                                            : 'bg-white text-gray-800 border border-gray-200 rounded-tl-sm shadow-sm'
                                    }`}>
                                        <MessageContent content={msg.content} isAssistant={msg.role === 'assistant'} />
                                    </div>
                                    {msg.role === 'assistant' && <CopyButton text={msg.content} />}
                                </div>

                                {/* Timestamp + Trace ID */}
                                <div className={`flex items-center gap-2 px-1 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <span className="text-xs text-gray-400">{formatTime(msg.timestamp)}</span>
                                    {msg.traceId && (
                                        <span className="text-xs text-gray-300 font-mono">
                                            · {msg.traceId.substring(0, 8)}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}

                    {/* Typing indicator */}
                    {loading && (
                        <div className="flex justify-start">
                            <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                                <div className="flex gap-1 items-center">
                                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                </div>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
            </div>

            {/* Input — fixed bottom */}
            <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-3 z-10">
                <div className="max-w-2xl mx-auto flex gap-2 items-end">
                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                sendMessage();
                            }
                        }}
                        placeholder="Digite sua mensagem… (Enter para enviar, Shift+Enter para nova linha)"
                        rows={1}
                        className="flex-1 resize-none bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 placeholder-gray-400 overflow-y-auto"
                        style={{ minHeight: '42px', maxHeight: '120px' }}
                    />
                    <button
                        onClick={sendMessage}
                        disabled={loading || !input.trim()}
                        aria-label="Enviar mensagem"
                        className="w-10 h-10 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors shrink-0"
                    >
                        {loading
                            ? <Loader2 className="w-4 h-4 text-white animate-spin" />
                            : <Send className="w-4 h-4 text-white" />
                        }
                    </button>
                </div>
                <p className="text-xs text-gray-400 text-center mt-1.5 font-mono">
                    Session: {sessionId.substring(0, 8)}…
                </p>
            </div>
        </div>
    );
}

// ── Page export ────────────────────────────────────────────────────────────

export default function ChatPage({ params }: { params: { assistantId: string } }) {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-gray-50 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
            </div>
        }>
            <ChatUI assistantId={params.assistantId} />
        </Suspense>
    );
}
