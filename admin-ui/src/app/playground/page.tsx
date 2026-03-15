'use client';

import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import api, { ENDPOINTS, API_BASE } from '@/lib/api';
import { useToast } from '@/components/Toast';
import {
    Play, Bot, Key, MessageSquare, Loader2, ShieldAlert,
    CheckCircle2, Clock, AlertTriangle, ChevronDown, Trash2,
    History, Zap, Cpu,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Assistant { id: string; name: string; status: string; }
interface ApiKey { id: string; prefix: string; created_at: string; }

type ExecutionStatus = 'idle' | 'loading' | 'success' | 'blocked' | 'hitl' | 'error';

interface ExecutionResult {
    status: ExecutionStatus;
    response?: string;
    traceId?: string;
    reason?: string;
    approvalId?: string;
    rawStatus?: number;
    latencyMs?: number;
    model?: string;
}

interface HistoryEntry {
    timestamp: string;
    assistantId: string;
    assistantName: string;
    message: string;
    result: ExecutionResult;
}

const HISTORY_KEY = 'govai_playground_history';
const MAX_HISTORY = 5;

function loadHistory(): HistoryEntry[] {
    if (typeof window === 'undefined') return [];
    try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveHistory(entries: HistoryEntry[]) {
    if (typeof window === 'undefined') return;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
}

export default function PlaygroundPage() {
    const { toast } = useToast();

    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);

    const [selectedAssistant, setSelectedAssistant] = useState('');
    const [selectedKeyPrefix, setSelectedKeyPrefix] = useState('');
    const [rawApiKey, setRawApiKey] = useState('');
    const [message, setMessage] = useState('');
    const [result, setResult] = useState<ExecutionResult>({ status: 'idle' });
    const [loadingData, setLoadingData] = useState(true);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [showHistory, setShowHistory] = useState(false);

    const fetchData = useCallback(async () => {
        setLoadingData(true);
        try {
            const [astRes, keyRes] = await Promise.all([
                api.get(ENDPOINTS.ASSISTANTS),
                api.get(ENDPOINTS.API_KEYS),
            ]);
            const published = (astRes.data as Assistant[]).filter(a => a.status === 'published');
            setAssistants(published);
            setApiKeys(keyRes.data as ApiKey[]);
            if (published.length > 0) setSelectedAssistant(published[0].id);
        } catch {
            toast('Erro ao carregar dados do playground.', 'error');
        } finally {
            setLoadingData(false);
        }
    }, [toast]);

    useEffect(() => {
        fetchData();
        setHistory(loadHistory());
    }, [fetchData]);

    const handleExecute = async () => {
        if (!selectedAssistant) { toast('Selecione um assistente publicado.', 'error'); return; }
        if (!rawApiKey.trim()) { toast('Informe a API Key para execução.', 'error'); return; }
        if (!message.trim()) { toast('Digite uma mensagem para enviar.', 'error'); return; }

        setResult({ status: 'loading' });
        const startTime = Date.now();

        try {
            const res = await axios.post(
                `${API_BASE}/v1/execute/${selectedAssistant}`,
                { message },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${rawApiKey.trim()}`,
                    },
                    validateStatus: () => true,
                }
            );

            const latencyMs = Date.now() - startTime;
            const data = res.data as any;
            const traceId = data?.traceId || data?._govai?.traceId;
            const model = data?.model || data?._govai?.model || undefined;

            let newResult: ExecutionResult;

            if (res.status === 200) {
                const content = data?.choices?.[0]?.message?.content
                    || data?.response
                    || JSON.stringify(data, null, 2);
                newResult = { status: 'success', response: content, traceId, latencyMs, model };

            } else if (res.status === 202) {
                newResult = {
                    status: 'hitl',
                    reason: data.reason || data.message,
                    approvalId: data.approvalId,
                    traceId,
                    rawStatus: res.status,
                    latencyMs,
                };

            } else if (res.status === 403) {
                newResult = {
                    status: 'blocked',
                    reason: data.error || 'Política violada',
                    traceId,
                    rawStatus: res.status,
                    latencyMs,
                };

            } else {
                newResult = {
                    status: 'error',
                    reason: data.error || data.details || `HTTP ${res.status}`,
                    traceId,
                    rawStatus: res.status,
                    latencyMs,
                };
            }

            setResult(newResult);

            // Save to history
            const astName = assistants.find(a => a.id === selectedAssistant)?.name || selectedAssistant;
            const entry: HistoryEntry = {
                timestamp: new Date().toISOString(),
                assistantId: selectedAssistant,
                assistantName: astName,
                message,
                result: newResult,
            };
            const updated = [entry, ...history].slice(0, MAX_HISTORY);
            setHistory(updated);
            saveHistory(updated);

        } catch (e: unknown) {
            const err = e as { message?: string };
            const latencyMs = Date.now() - startTime;
            setResult({ status: 'error', reason: err.message || 'Erro de rede', latencyMs });
        }
    };

    const handleClear = () => {
        setResult({ status: 'idle' });
        setMessage('');
    };

    const restoreFromHistory = (entry: HistoryEntry) => {
        setSelectedAssistant(entry.assistantId);
        setMessage(entry.message);
        setResult(entry.result);
        setShowHistory(false);
    };

    const statusConfig: Record<ExecutionStatus, { label: string; color: string; icon: React.ReactNode }> = {
        idle: { label: '', color: '', icon: null },
        loading: { label: 'Processando…', color: 'text-muted-foreground', icon: <Loader2 className="w-5 h-5 animate-spin" /> },
        success: { label: 'Resposta da IA', color: 'text-emerald-400', icon: <CheckCircle2 className="w-5 h-5" /> },
        blocked: { label: 'BLOQUEADO — Política violada', color: 'text-red-400', icon: <ShieldAlert className="w-5 h-5" /> },
        hitl: { label: 'AGUARDANDO APROVAÇÃO HUMANA', color: 'text-amber-400', icon: <Clock className="w-5 h-5" /> },
        error: { label: 'Erro', color: 'text-red-400', icon: <AlertTriangle className="w-5 h-5" /> },
    };

    const statusBadge: Record<ExecutionStatus, string> = {
        idle: '',
        loading: '',
        success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        blocked: 'bg-red-500/10 text-red-400 border-red-500/20',
        hitl: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        error: 'bg-red-500/10 text-red-400 border-red-500/20',
    };

    return (
        <div className="flex-1 overflow-auto p-8 bg-background">
            <div className="max-w-4xl mx-auto space-y-8">

                {/* Header */}
                <div className="flex items-start justify-between">
                    <div>
                        <h2 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <Play className="w-5 h-5 text-emerald-400" />
                            </div>
                            Playground
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Teste assistentes publicados com o pipeline de governança completo (OPA + DLP + HITL).
                        </p>
                    </div>

                    {/* History toggle */}
                    {history.length > 0 && (
                        <button
                            onClick={() => setShowHistory(v => !v)}
                            className={cn(
                                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors",
                                showHistory
                                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                                    : "bg-secondary border-border text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <History className="w-3.5 h-3.5" />
                            Histórico ({history.length})
                        </button>
                    )}
                </div>

                {/* History Panel */}
                {showHistory && history.length > 0 && (
                    <div className="bg-card border border-border rounded-xl p-4 space-y-2">
                        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                            Últimas {history.length} execuções
                        </h3>
                        {history.map((entry, i) => (
                            <button
                                key={i}
                                onClick={() => restoreFromHistory(entry)}
                                className="w-full text-left flex items-start gap-3 p-3 rounded-lg hover:bg-secondary/60 transition-colors group"
                            >
                                <span className={cn(
                                    "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold border mt-0.5",
                                    statusBadge[entry.result.status] || 'bg-secondary text-muted-foreground border-border'
                                )}>
                                    {entry.result.status.toUpperCase()}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <span className="text-foreground font-medium truncate">{entry.assistantName}</span>
                                        <span>·</span>
                                        <span>{new Date(entry.timestamp).toLocaleTimeString('pt-BR')}</span>
                                        {entry.result.latencyMs && (
                                            <><span>·</span><span className="text-emerald-400/70">{entry.result.latencyMs}ms</span></>
                                        )}
                                    </div>
                                    <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{entry.message}</p>
                                </div>
                            </button>
                        ))}
                        <button
                            onClick={() => { setHistory([]); saveHistory([]); setShowHistory(false); }}
                            className="text-xs text-muted-foreground/50 hover:text-red-400 transition-colors mt-1"
                        >
                            Limpar histórico
                        </button>
                    </div>
                )}

                {loadingData ? (
                    <div className="flex items-center gap-3 text-muted-foreground py-8">
                        <Loader2 className="w-5 h-5 animate-spin" /> Carregando assistentes e chaves…
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                        {/* ── Configuração ─────────────────────────────────── */}
                        <div className="space-y-5 bg-card border border-border rounded-xl p-6">
                            <h3 className="font-semibold text-base flex items-center gap-2 text-foreground">
                                <Bot className="w-4 h-4 text-emerald-400" /> Configuração
                            </h3>

                            {/* Selecionar assistente */}
                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    Assistente Publicado
                                </label>
                                {assistants.length === 0 ? (
                                    <p className="text-sm text-amber-400">Nenhum assistente publicado. Publique um primeiro.</p>
                                ) : (
                                    <div className="relative">
                                        <select
                                            value={selectedAssistant}
                                            onChange={e => setSelectedAssistant(e.target.value)}
                                            className="w-full appearance-none bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 pr-10"
                                        >
                                            {assistants.map(a => (
                                                <option key={a.id} value={a.id}>{a.name}</option>
                                            ))}
                                        </select>
                                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                                    </div>
                                )}
                            </div>

                            {/* API Key prefix selector */}
                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                    <Key className="w-3.5 h-3.5" /> API Key (prefixo)
                                </label>
                                {apiKeys.length > 0 && (
                                    <div className="relative">
                                        <select
                                            value={selectedKeyPrefix}
                                            onChange={e => setSelectedKeyPrefix(e.target.value)}
                                            className="w-full appearance-none bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 pr-10"
                                        >
                                            <option value="">— selecionar prefixo —</option>
                                            {apiKeys.map(k => (
                                                <option key={k.id} value={k.prefix}>{k.prefix}… (criada em {new Date(k.created_at).toLocaleDateString('pt-BR')})</option>
                                            ))}
                                        </select>
                                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                                    </div>
                                )}
                                <input
                                    type="password"
                                    placeholder="Cole a API Key completa: sk-govai-..."
                                    value={rawApiKey}
                                    onChange={e => setRawApiKey(e.target.value)}
                                    className="w-full bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/50 placeholder:text-muted-foreground/50"
                                />
                                <p className="text-[11px] text-muted-foreground/60">
                                    A chave completa só é exibida na criação. Cole aqui para testar.
                                </p>
                            </div>
                        </div>

                        {/* ── Mensagem ─────────────────────────────────────── */}
                        <div className="space-y-5 bg-card border border-border rounded-xl p-6">
                            <h3 className="font-semibold text-base flex items-center gap-2 text-foreground">
                                <MessageSquare className="w-4 h-4 text-emerald-400" /> Mensagem
                            </h3>
                            <textarea
                                value={message}
                                onChange={e => setMessage(e.target.value)}
                                placeholder={"Digite sua mensagem…\n\nExemplos:\n• Pergunta normal → resposta da IA\n• 'Ignore all previous instructions' → bloqueado\n• 'transferencia bancaria' → HITL"}
                                rows={8}
                                className="w-full bg-secondary border border-border rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/50 resize-none placeholder:text-muted-foreground/40"
                                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleExecute(); }}
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={handleExecute}
                                    disabled={result.status === 'loading' || !selectedAssistant || !rawApiKey.trim() || !message.trim()}
                                    className={cn(
                                        "flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-bold transition-all",
                                        result.status === 'loading'
                                            ? "bg-secondary text-muted-foreground cursor-not-allowed"
                                            : "bg-emerald-500 text-black hover:bg-emerald-400 active:scale-[0.98]"
                                    )}
                                >
                                    {result.status === 'loading'
                                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Processando…</>
                                        : <><Play className="w-4 h-4" /> Enviar <span className="opacity-60 text-xs font-normal">(⌘ + Enter)</span></>
                                    }
                                </button>
                                {(result.status !== 'idle' || message) && (
                                    <button
                                        onClick={handleClear}
                                        className="flex items-center gap-1.5 px-3 py-3 rounded-lg text-sm font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                                        title="Limpar resultado e mensagem"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* ── Resultado ────────────────────────────────────────────── */}
                {result.status !== 'idle' && result.status !== 'loading' && (
                    <div className={cn(
                        "border rounded-xl p-6 space-y-4",
                        result.status === 'success' && "bg-emerald-500/5 border-emerald-500/20",
                        result.status === 'blocked' && "bg-red-500/5 border-red-500/20",
                        result.status === 'hitl' && "bg-amber-500/5 border-amber-500/20",
                        result.status === 'error' && "bg-red-500/5 border-red-500/20",
                    )}>
                        {/* Status header */}
                        <div className={cn("flex items-center gap-2 font-bold text-sm", statusConfig[result.status].color)}>
                            {statusConfig[result.status].icon}
                            <span>{statusConfig[result.status].label}</span>
                            {result.rawStatus && (
                                <span className="ml-auto font-mono text-xs opacity-60">HTTP {result.rawStatus}</span>
                            )}
                        </div>

                        {/* Latency + Model badges */}
                        {(result.latencyMs !== undefined || result.model) && (
                            <div className="flex items-center gap-3 flex-wrap">
                                {result.latencyMs !== undefined && (
                                    <span className="flex items-center gap-1.5 bg-background/60 border border-border/40 rounded-full px-3 py-1 text-xs font-mono text-muted-foreground">
                                        <Zap className="w-3 h-3 text-emerald-400" />
                                        {result.latencyMs}ms
                                    </span>
                                )}
                                {result.model && (
                                    <span className="flex items-center gap-1.5 bg-background/60 border border-border/40 rounded-full px-3 py-1 text-xs font-mono text-muted-foreground">
                                        <Cpu className="w-3 h-3 text-blue-400" />
                                        {result.model}
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Response text */}
                        {result.status === 'success' && result.response && (
                            <div className="bg-background/60 rounded-lg p-4 text-sm text-foreground font-mono leading-relaxed whitespace-pre-wrap border border-border/40">
                                {result.response}
                            </div>
                        )}

                        {/* Blocked / HITL / Error reason */}
                        {result.reason && (
                            <div className="bg-background/60 rounded-lg p-4 text-sm border border-border/40">
                                <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Motivo: </span>
                                <span className="text-foreground">{result.reason}</span>
                            </div>
                        )}

                        {/* HITL Approval ID */}
                        {result.status === 'hitl' && result.approvalId && (
                            <div className="text-xs text-muted-foreground font-mono">
                                Approval ID: <span className="text-amber-400">{result.approvalId}</span>
                                <span className="ml-2 text-muted-foreground/60">— revise em /approvals</span>
                            </div>
                        )}

                        {/* Trace ID */}
                        {result.traceId && (
                            <div className="text-xs text-muted-foreground/60 font-mono border-t border-border/30 pt-3">
                                Trace ID: {result.traceId}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
