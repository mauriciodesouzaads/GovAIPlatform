'use client';

import { useEffect, useState, useCallback } from 'react';
import {
    BookOpen, ChevronRight, X, Tag, Calendar, User,
    AlertTriangle, CheckCircle2, Clock, Loader2, ExternalLink,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';

// ── Types ──────────────────────────────────────────────────────────────────

interface Assistant {
    id: string;
    name: string;
    description?: string;
    model?: string;
    lifecycle_state?: string;   // draft | active | deprecated | archived
    risk_level?: string;        // low | medium | high | critical
    capability_tags?: string[];
    owner_email?: string;
    reviewed_at?: string;
    created_at: string;
    updated_at?: string;
    system_prompt?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function lifecycleColor(s?: string) {
    switch (s) {
        case 'active':      return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'draft':       return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'deprecated':  return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
        case 'archived':    return 'text-gray-500 bg-gray-500/10 border-gray-500/20';
        default:            return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
    }
}

function riskColor(r?: string) {
    switch (r) {
        case 'critical':    return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        case 'high':        return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
        case 'medium':      return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'low':         return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        default:            return 'text-gray-400 bg-gray-400/10 border-gray-400/20';
    }
}

function fmtDate(d?: string) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Side Drawer ────────────────────────────────────────────────────────────

function AssistantDrawer({ assistant, onClose }: { assistant: Assistant; onClose: () => void }) {
    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
                onClick={onClose}
            />
            {/* Panel */}
            <aside className="fixed right-0 top-0 h-full w-full max-w-lg bg-[#0f0f0f] border-l border-white/10 z-50 flex flex-col overflow-hidden shadow-2xl">
                {/* Header */}
                <div className="flex items-start justify-between p-6 border-b border-white/10">
                    <div>
                        <h2 className="text-lg font-semibold text-white">{assistant.name}</h2>
                        <p className="text-sm text-gray-400 mt-0.5">{assistant.id}</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-500 hover:text-white transition-colors p-1"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Badges row */}
                    <div className="flex flex-wrap gap-2">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${lifecycleColor(assistant.lifecycle_state)}`}>
                            {assistant.lifecycle_state ?? 'active'}
                        </span>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${riskColor(assistant.risk_level)}`}>
                            Risk: {assistant.risk_level ?? 'low'}
                        </span>
                        {assistant.model && (
                            <span className="px-2.5 py-1 rounded-full text-xs font-medium border text-purple-400 bg-purple-500/10 border-purple-500/20">
                                {assistant.model}
                            </span>
                        )}
                    </div>

                    {/* Description */}
                    {assistant.description && (
                        <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Descrição</p>
                            <p className="text-sm text-gray-300">{assistant.description}</p>
                        </div>
                    )}

                    {/* System Prompt */}
                    {assistant.system_prompt && (
                        <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">System Prompt</p>
                            <pre className="text-xs text-gray-400 bg-white/5 border border-white/10 rounded-lg p-3 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                                {assistant.system_prompt}
                            </pre>
                        </div>
                    )}

                    {/* Capability Tags */}
                    {assistant.capability_tags && assistant.capability_tags.length > 0 && (
                        <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Capability Tags</p>
                            <div className="flex flex-wrap gap-1.5">
                                {assistant.capability_tags.map(tag => (
                                    <span key={tag} className="px-2 py-0.5 rounded text-xs bg-white/5 border border-white/10 text-gray-300">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Meta */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Owner</p>
                            <p className="text-sm text-gray-300 flex items-center gap-1.5">
                                <User className="w-3.5 h-3.5 text-gray-500" />
                                {assistant.owner_email ?? '—'}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Revisado em</p>
                            <p className="text-sm text-gray-300 flex items-center gap-1.5">
                                <CheckCircle2 className="w-3.5 h-3.5 text-gray-500" />
                                {fmtDate(assistant.reviewed_at)}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Criado em</p>
                            <p className="text-sm text-gray-300 flex items-center gap-1.5">
                                <Calendar className="w-3.5 h-3.5 text-gray-500" />
                                {fmtDate(assistant.created_at)}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Atualizado em</p>
                            <p className="text-sm text-gray-300 flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5 text-gray-500" />
                                {fmtDate(assistant.updated_at)}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-white/10">
                    <a
                        href="/playground"
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-colors"
                    >
                        <ExternalLink className="w-4 h-4" />
                        Iniciar Chat
                    </a>
                </div>
            </aside>
        </>
    );
}

// ── Card ───────────────────────────────────────────────────────────────────

function AssistantCard({ assistant, onDetails }: { assistant: Assistant; onDetails: () => void }) {
    return (
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-5 flex flex-col gap-4 hover:border-amber-500/30 hover:bg-white/[0.05] transition-all">
            {/* Top row */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-white text-sm leading-snug truncate">{assistant.name}</h3>
                    {assistant.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{assistant.description}</p>
                    )}
                </div>
                <ChevronRight className="w-4 h-4 text-gray-600 shrink-0 mt-0.5" />
            </div>

            {/* Badges */}
            <div className="flex flex-wrap gap-1.5">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${lifecycleColor(assistant.lifecycle_state)}`}>
                    {assistant.lifecycle_state ?? 'active'}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${riskColor(assistant.risk_level)}`}>
                    {assistant.risk_level ?? 'low'}
                </span>
            </div>

            {/* Capability tags */}
            {assistant.capability_tags && assistant.capability_tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {assistant.capability_tags.slice(0, 4).map(tag => (
                        <span key={tag} className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-white/5 border border-white/10 text-gray-400">
                            <Tag className="w-2.5 h-2.5" />{tag}
                        </span>
                    ))}
                    {assistant.capability_tags.length > 4 && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 border border-white/10 text-gray-500">
                            +{assistant.capability_tags.length - 4}
                        </span>
                    )}
                </div>
            )}

            {/* Meta footer */}
            <div className="flex items-center justify-between text-[10px] text-gray-600 border-t border-white/5 pt-3">
                <span className="flex items-center gap-1">
                    <User className="w-3 h-3" />
                    {assistant.owner_email ?? '—'}
                </span>
                <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {fmtDate(assistant.reviewed_at)}
                </span>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
                <a
                    href="/playground"
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500 hover:bg-amber-400 text-black transition-colors text-center"
                >
                    Iniciar Chat
                </a>
                <button
                    onClick={onDetails}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/10 text-gray-400 hover:text-white hover:border-white/20 transition-colors"
                >
                    Ver Detalhes
                </button>
            </div>
        </div>
    );
}

// ── Page ───────────────────────────────────────────────────────────────────

const LIFECYCLE_FILTERS = ['all', 'active', 'draft', 'deprecated', 'archived'];
const RISK_FILTERS = ['all', 'critical', 'high', 'medium', 'low'];

export default function CatalogPage() {
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [lifecycleFilter, setLifecycleFilter] = useState('all');
    const [riskFilter, setRiskFilter] = useState('all');
    const [selected, setSelected] = useState<Assistant | null>(null);
    const { toast } = useToast();

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const res = await api.get(ENDPOINTS.CATALOG_ASSISTANTS);
            setAssistants(res.data?.assistants ?? res.data ?? []);
        } catch (e: any) {
            const msg = e.response?.data?.error ?? e.message;
            setError(msg);
            toast(msg, 'error');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => { load(); }, [load]);

    const filtered = assistants.filter(a => {
        const matchSearch = !search || a.name.toLowerCase().includes(search.toLowerCase()) ||
            (a.description ?? '').toLowerCase().includes(search.toLowerCase()) ||
            (a.owner_email ?? '').toLowerCase().includes(search.toLowerCase());
        const matchLifecycle = lifecycleFilter === 'all' || (a.lifecycle_state ?? 'active') === lifecycleFilter;
        const matchRisk = riskFilter === 'all' || (a.risk_level ?? 'low') === riskFilter;
        return matchSearch && matchLifecycle && matchRisk;
    });

    return (
        <div className="relative min-h-screen bg-black text-white overflow-hidden">
            {/* Grid background */}
            <div className="absolute inset-0 bg-[url('/grid.svg')] opacity-[0.03] pointer-events-none" />
            <div className="absolute inset-0 bg-gradient-to-b from-amber-500/5 via-transparent to-transparent pointer-events-none" />

            <div className="relative max-w-[1400px] mx-auto px-6 py-8 space-y-8">

                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                            <BookOpen className="w-5 h-5 text-amber-400" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-white tracking-tight">Catálogo de Agentes</h1>
                            <p className="text-sm text-gray-500">Registry formal de capacidades de IA — ciclo de vida, risco e governança.</p>
                        </div>
                    </div>
                    <button
                        onClick={load}
                        disabled={loading}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 text-gray-400 hover:text-white hover:border-white/20 text-sm transition-colors disabled:opacity-50"
                    >
                        <Loader2 className={`w-4 h-4 ${loading ? 'animate-spin' : 'hidden'}`} />
                        Atualizar
                    </button>
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-3">
                    <input
                        type="text"
                        placeholder="Buscar por nome, descrição ou owner..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
                    />
                    <div className="flex gap-2 flex-wrap">
                        {LIFECYCLE_FILTERS.map(f => (
                            <button
                                key={f}
                                onClick={() => setLifecycleFilter(f)}
                                className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                                    lifecycleFilter === f
                                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                                        : 'border-white/10 text-gray-500 hover:text-gray-300'
                                }`}
                            >
                                {f === 'all' ? 'Todos' : f}
                            </button>
                        ))}
                        <div className="w-px bg-white/10 self-stretch mx-1" />
                        {RISK_FILTERS.map(f => (
                            <button
                                key={f}
                                onClick={() => setRiskFilter(f)}
                                className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                                    riskFilter === f
                                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                                        : 'border-white/10 text-gray-500 hover:text-gray-300'
                                }`}
                            >
                                {f === 'all' ? 'Todos riscos' : f}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Summary bar */}
                <p className="text-xs text-gray-600">
                    {filtered.length} assistente{filtered.length !== 1 ? 's' : ''} encontrado{filtered.length !== 1 ? 's' : ''}
                    {assistants.length !== filtered.length && ` de ${assistants.length} total`}
                </p>

                {/* Error */}
                {error && (
                    <div className="flex items-center gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        {error}
                    </div>
                )}

                {/* Grid */}
                {loading ? (
                    <div className="flex items-center justify-center py-24 text-gray-600">
                        <Loader2 className="w-8 h-8 animate-spin mr-3" />
                        Carregando catálogo...
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-24 text-gray-600 gap-3">
                        <BookOpen className="w-10 h-10 opacity-30" />
                        <p className="text-sm">Nenhum assistente encontrado com os filtros selecionados.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {filtered.map(a => (
                            <AssistantCard key={a.id} assistant={a} onDetails={() => setSelected(a)} />
                        ))}
                    </div>
                )}
            </div>

            {/* Side Drawer */}
            {selected && <AssistantDrawer assistant={selected} onClose={() => setSelected(null)} />}
        </div>
    );
}
