'use client';

import { useEffect, useState, useCallback } from 'react';
import {
    BookOpen, ChevronRight, X, Tag, Calendar, User,
    AlertTriangle, CheckCircle2, Clock, Loader2, ExternalLink,
    Archive, ShieldAlert, Link2, Copy,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';

// ── Types ──────────────────────────────────────────────────────────────────

interface Assistant {
    id: string;
    name: string;
    description?: string;
    model?: string;
    lifecycle_state?: string;   // draft | under_review | approved | official | suspended | archived
    risk_level?: string;        // low | medium | high | critical
    risk_justification?: string;
    capability_tags?: string[];
    owner_email?: string;
    reviewed_at?: string;
    suspended_at?: string;
    archived_at?: string;
    created_at: string;
    updated_at?: string;
    version_count?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function lifecycleColor(s?: string) {
    switch (s) {
        case 'approved':        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'official':        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'under_review':    return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'draft':           return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
        case 'suspended':       return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        case 'archived':        return 'text-gray-500 bg-gray-500/10 border-gray-500/20';
        default:                return 'text-gray-400 bg-gray-400/10 border-gray-400/20';
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

// ── Action Modal ───────────────────────────────────────────────────────────

interface ActionModalProps {
    title: string;
    description: string;
    inputLabel?: string;
    inputRequired?: boolean;
    inputMin?: number;
    confirmLabel: string;
    confirmClass: string;
    onConfirm: (value: string) => void;
    onClose: () => void;
    loading: boolean;
}

function ActionModal({
    title, description, inputLabel, inputRequired, inputMin = 0,
    confirmLabel, confirmClass, onConfirm, onClose, loading,
}: ActionModalProps) {
    const [value, setValue] = useState('');
    const canConfirm = !inputRequired || value.trim().length >= inputMin;

    return (
        <>
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60]" onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center z-[70] p-4">
                <div className="bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-md shadow-2xl space-y-4">
                    <div className="flex items-start justify-between">
                        <h3 className="font-semibold text-white text-base">{title}</h3>
                        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="text-sm text-gray-400">{description}</p>
                    {inputLabel && (
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                {inputLabel}
                            </label>
                            <textarea
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                rows={3}
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50 resize-none"
                                placeholder={inputRequired ? `Mínimo ${inputMin} caracteres` : 'Opcional'}
                            />
                            {inputRequired && value.trim().length > 0 && value.trim().length < inputMin && (
                                <p className="text-xs text-rose-400">
                                    Mínimo {inputMin} caracteres ({value.trim().length}/{inputMin})
                                </p>
                            )}
                        </div>
                    )}
                    <div className="flex gap-2 justify-end pt-1">
                        <button
                            onClick={onClose}
                            disabled={loading}
                            className="px-4 py-2 rounded-lg text-sm border border-white/10 text-gray-400 hover:text-white hover:border-white/20 transition-colors disabled:opacity-50"
                        >
                            Cancelar
                        </button>
                        <button
                            onClick={() => onConfirm(value)}
                            disabled={loading || !canConfirm}
                            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center gap-2 ${confirmClass}`}
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

// ── Side Drawer ────────────────────────────────────────────────────────────

type DrawerTab = 'details' | 'lifecycle' | 'chat';

interface DrawerProps {
    assistant: Assistant;
    onClose: () => void;
    onReload: () => void;
    isAdmin: boolean;
}

function AssistantDrawer({ assistant: initialAssistant, onClose, onReload, isAdmin }: DrawerProps) {
    const [tab, setTab] = useState<DrawerTab>('details');
    const [assistant, setAssistant] = useState(initialAssistant);
    const [actionLoading, setActionLoading] = useState(false);
    const [modal, setModal] = useState<null | { type: 'approve' | 'reject' | 'suspend' | 'archive' }>(null);
    const { toast } = useToast();

    useEffect(() => { setAssistant(initialAssistant); }, [initialAssistant]);

    const callAction = async (fn: () => Promise<void>) => {
        setActionLoading(true);
        try { await fn(); } finally { setActionLoading(false); }
    };

    const submitForReview = () => callAction(async () => {
        try {
            await api.post(ENDPOINTS.CATALOG_SUBMIT_REVIEW(assistant.id));
            toast('Submetido para revisão', 'success');
            setAssistant(a => ({ ...a, lifecycle_state: 'under_review' }));
            onReload();
        } catch (e: any) {
            toast(e.response?.data?.error ?? e.message, 'error');
        }
    });

    const doReview = (decision: string, comments: string) => callAction(async () => {
        try {
            await api.post(ENDPOINTS.CATALOG_REVIEW(assistant.id), { decision, comments });
            toast(decision === 'approved' ? 'Assistente aprovado!' : 'Revisão registrada', 'success');
            setModal(null);
            setAssistant(a => ({ ...a, lifecycle_state: decision === 'approved' ? 'approved' : 'draft' }));
            onReload();
        } catch (e: any) {
            toast(e.response?.data?.error ?? e.message, 'error');
        }
    });

    const doSuspend = (reason: string) => callAction(async () => {
        try {
            await api.post(ENDPOINTS.CATALOG_SUSPEND(assistant.id), { reason });
            toast('Assistente suspenso', 'success');
            setModal(null);
            setAssistant(a => ({ ...a, lifecycle_state: 'suspended' }));
            onReload();
        } catch (e: any) {
            toast(e.response?.data?.error ?? e.message, 'error');
        }
    });

    const doArchive = (reason: string) => callAction(async () => {
        try {
            await api.post(ENDPOINTS.CATALOG_ARCHIVE(assistant.id), {
                reason: reason.trim() || 'Arquivado pelo administrador',
            });
            toast('Assistente arquivado', 'success');
            setModal(null);
            setAssistant(a => ({ ...a, lifecycle_state: 'archived' }));
            onReload();
        } catch (e: any) {
            toast(e.response?.data?.error ?? e.message, 'error');
        }
    });

    const state = assistant.lifecycle_state;

    const tabs: { key: DrawerTab; label: string }[] = [
        { key: 'details', label: 'Detalhes' },
        ...(isAdmin ? [{ key: 'lifecycle' as DrawerTab, label: 'Lifecycle' }] : []),
        { key: 'chat', label: 'Chat' },
    ];

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" onClick={onClose} />

            {/* Panel */}
            <aside className="fixed right-0 top-0 h-full w-full max-w-lg bg-[#0f0f0f] border-l border-white/10 z-50 flex flex-col overflow-hidden shadow-2xl">

                {/* Header */}
                <div className="flex items-start justify-between p-6 border-b border-white/10">
                    <div>
                        <h2 className="text-lg font-semibold text-white">{assistant.name}</h2>
                        <p className="text-sm text-gray-400 mt-0.5">{assistant.id}</p>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors p-1">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-white/10">
                    {tabs.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                                tab === t.key
                                    ? 'border-amber-500 text-amber-400'
                                    : 'border-transparent text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6">

                    {/* Tab: Detalhes */}
                    {tab === 'details' && (
                        <div className="space-y-6">
                            <div className="flex flex-wrap gap-2">
                                <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${lifecycleColor(state)}`}>
                                    {state ?? 'draft'}
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

                            {assistant.description && (
                                <div>
                                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Descrição</p>
                                    <p className="text-sm text-gray-300">{assistant.description}</p>
                                </div>
                            )}

                            {assistant.risk_justification && (
                                <div>
                                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Justificativa de Risco</p>
                                    <p className="text-sm text-gray-300">{assistant.risk_justification}</p>
                                </div>
                            )}

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

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Owner</p>
                                    <p className="text-sm text-gray-300 flex items-center gap-1.5">
                                        <User className="w-3.5 h-3.5 text-gray-500" />
                                        {assistant.owner_email ?? '—'}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Versões</p>
                                    <p className="text-sm text-gray-300">{assistant.version_count ?? 0}</p>
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
                            </div>
                        </div>
                    )}

                    {/* Tab: Lifecycle (admin only) */}
                    {tab === 'lifecycle' && isAdmin && (
                        <div className="space-y-5">
                            {/* Current state */}
                            <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Estado atual</p>
                                <span className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${lifecycleColor(state)}`}>
                                    {state ?? 'draft'}
                                </span>
                            </div>

                            {/* Actions per state */}
                            <div className="space-y-3">
                                {state === 'draft' && (
                                    <button
                                        onClick={submitForReview}
                                        disabled={actionLoading}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-colors disabled:opacity-50"
                                    >
                                        {actionLoading
                                            ? <Loader2 className="w-4 h-4 animate-spin" />
                                            : <Clock className="w-4 h-4" />
                                        }
                                        Submeter para Revisão
                                    </button>
                                )}

                                {state === 'under_review' && (
                                    <>
                                        <button
                                            onClick={() => setModal({ type: 'approve' })}
                                            disabled={actionLoading}
                                            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-sm transition-colors disabled:opacity-50"
                                        >
                                            <CheckCircle2 className="w-4 h-4" />
                                            Aprovar
                                        </button>
                                        <button
                                            onClick={() => setModal({ type: 'reject' })}
                                            disabled={actionLoading}
                                            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-rose-500/50 text-rose-400 hover:bg-rose-500/10 font-semibold text-sm transition-colors disabled:opacity-50"
                                        >
                                            <AlertTriangle className="w-4 h-4" />
                                            Rejeitar
                                        </button>
                                    </>
                                )}

                                {(state === 'approved' || state === 'official') && (
                                    <button
                                        onClick={() => setModal({ type: 'suspend' })}
                                        disabled={actionLoading}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-amber-500/50 text-amber-400 hover:bg-amber-500/10 font-semibold text-sm transition-colors disabled:opacity-50"
                                    >
                                        <ShieldAlert className="w-4 h-4" />
                                        Suspender
                                    </button>
                                )}

                                {state === 'approved' && (
                                    <div className="text-xs text-gray-500 bg-white/[0.02] border border-white/5 rounded-lg p-3 leading-relaxed">
                                        Para publicar como <strong className="text-white">oficial</strong>, publique uma versão do assistente
                                        na página{' '}
                                        <a href="/assistants" className="text-amber-400 hover:underline">Assistentes</a>.
                                    </div>
                                )}

                                {state === 'suspended' && (
                                    <button
                                        onClick={() => setModal({ type: 'archive' })}
                                        disabled={actionLoading}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-500/50 text-gray-400 hover:bg-gray-500/10 font-semibold text-sm transition-colors disabled:opacity-50"
                                    >
                                        <Archive className="w-4 h-4" />
                                        Arquivar
                                    </button>
                                )}

                                {state === 'archived' && (
                                    <div className="flex items-center gap-2 text-sm text-gray-500 bg-white/[0.02] border border-white/5 rounded-lg p-4">
                                        <Archive className="w-4 h-4 shrink-0" />
                                        Este assistente está arquivado. Nenhuma ação disponível.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Tab: Chat */}
                    {tab === 'chat' && (
                        <div className="space-y-5">
                            {/* Link Governado — only for official assistants */}
                            {state === 'official' ? (
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                        <Link2 className="w-4 h-4 text-emerald-400" />
                                        <p className="text-sm font-semibold text-white">Link Governado</p>
                                    </div>
                                    <p className="text-xs text-gray-500 leading-relaxed">
                                        Compartilhe este link com usuários finais. Adicione uma API Key válida ao final.
                                    </p>
                                    <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 font-mono text-xs text-gray-400 break-all">
                                        {typeof window !== 'undefined'
                                            ? `${window.location.origin}/chat/${assistant.id}?key=`
                                            : `/chat/${assistant.id}?key=`
                                        }
                                    </div>
                                    <button
                                        onClick={() => {
                                            const url = typeof window !== 'undefined'
                                                ? `${window.location.origin}/chat/${assistant.id}?key=`
                                                : `/chat/${assistant.id}?key=`;
                                            navigator.clipboard.writeText(url).then(() => {
                                                toast('Link base copiado!', 'success');
                                            }).catch(() => {
                                                toast('Não foi possível copiar', 'error');
                                            });
                                        }}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 text-sm font-medium transition-colors"
                                    >
                                        <Copy className="w-4 h-4" />
                                        Copiar Link Base
                                    </button>
                                    <div className="border-t border-white/5 pt-3" />
                                </div>
                            ) : (
                                <div className="flex items-start gap-2 text-xs text-gray-500 bg-white/[0.02] border border-white/5 rounded-lg p-3">
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600/70" />
                                    Assistente deve estar com status <strong className="text-white mx-1">official</strong>
                                    para gerar link de acesso externo.
                                </div>
                            )}

                            {/* Playground admin link */}
                            <div className="space-y-2">
                                <p className="text-xs text-gray-600">Teste no Playground com o pipeline completo (OPA + DLP + HITL).</p>
                                <a
                                    href="/playground"
                                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-colors"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    Abrir Playground Admin
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            </aside>

            {/* Modals */}
            {modal?.type === 'approve' && (
                <ActionModal
                    title="Aprovar Assistente"
                    description="Confirma a aprovação deste assistente no catálogo?"
                    inputLabel="Comentários da revisão"
                    inputRequired={false}
                    confirmLabel="Aprovar"
                    confirmClass="bg-emerald-500 hover:bg-emerald-400 text-black"
                    onConfirm={comments => doReview('approved', comments)}
                    onClose={() => setModal(null)}
                    loading={actionLoading}
                />
            )}
            {modal?.type === 'reject' && (
                <ActionModal
                    title="Rejeitar Assistente"
                    description="Informe o motivo da rejeição. O assistente voltará ao estado draft."
                    inputLabel="Motivo da rejeição"
                    inputRequired={true}
                    inputMin={20}
                    confirmLabel="Rejeitar"
                    confirmClass="bg-rose-500 hover:bg-rose-400 text-white"
                    onConfirm={comments => doReview('rejected', comments)}
                    onClose={() => setModal(null)}
                    loading={actionLoading}
                />
            )}
            {modal?.type === 'suspend' && (
                <ActionModal
                    title="Suspender Assistente"
                    description="Informe o motivo da suspensão. O assistente ficará indisponível."
                    inputLabel="Motivo da suspensão"
                    inputRequired={true}
                    inputMin={5}
                    confirmLabel="Suspender"
                    confirmClass="border border-amber-500/50 text-amber-400 hover:bg-amber-500/10"
                    onConfirm={reason => doSuspend(reason)}
                    onClose={() => setModal(null)}
                    loading={actionLoading}
                />
            )}
            {modal?.type === 'archive' && (
                <ActionModal
                    title="Arquivar Assistente"
                    description="Esta ação é irreversível. O assistente será arquivado permanentemente."
                    inputLabel="Motivo (opcional)"
                    inputRequired={false}
                    confirmLabel="Arquivar"
                    confirmClass="border border-gray-500/50 text-gray-400 hover:bg-gray-500/10"
                    onConfirm={reason => doArchive(reason)}
                    onClose={() => setModal(null)}
                    loading={actionLoading}
                />
            )}
        </>
    );
}

// ── Card ───────────────────────────────────────────────────────────────────

function AssistantCard({ assistant, onManage }: { assistant: Assistant; onManage: () => void }) {
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
                    {assistant.lifecycle_state ?? 'draft'}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${riskColor(assistant.risk_level)}`}>
                    {assistant.risk_level ?? 'low'}
                </span>
            </div>

            {/* Capability tags (up to 3 + overflow) */}
            {assistant.capability_tags && assistant.capability_tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {assistant.capability_tags.slice(0, 3).map(tag => (
                        <span key={tag} className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-white/5 border border-white/10 text-gray-400">
                            <Tag className="w-2.5 h-2.5" />{tag}
                        </span>
                    ))}
                    {assistant.capability_tags.length > 3 && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 border border-white/10 text-gray-500">
                            +{assistant.capability_tags.length - 3}
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
            <button
                onClick={onManage}
                className="w-full px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-colors"
            >
                Gerenciar
            </button>
        </div>
    );
}

// ── Page ───────────────────────────────────────────────────────────────────

const LIFECYCLE_FILTERS = ['all', 'draft', 'under_review', 'approved', 'official', 'suspended', 'archived'];
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
    const { role } = useAuth();
    const isAdmin = role === 'admin';

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const res = await api.get(ENDPOINTS.CATALOG_LIST);
            setAssistants(res.data?.assistants ?? []);
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
        const matchSearch = !search ||
            a.name.toLowerCase().includes(search.toLowerCase()) ||
            (a.description ?? '').toLowerCase().includes(search.toLowerCase()) ||
            (a.owner_email ?? '').toLowerCase().includes(search.toLowerCase());
        const matchLifecycle = lifecycleFilter === 'all' || (a.lifecycle_state ?? 'draft') === lifecycleFilter;
        const matchRisk = riskFilter === 'all' || (a.risk_level ?? 'low') === riskFilter;
        return matchSearch && matchLifecycle && matchRisk;
    });

    // When drawer reloads, keep selected in sync with refreshed assistants list
    const selectedFull = selected ? (assistants.find(a => a.id === selected.id) ?? selected) : null;

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
                            <AssistantCard key={a.id} assistant={a} onManage={() => setSelected(a)} />
                        ))}
                    </div>
                )}
            </div>

            {/* Side Drawer */}
            {selectedFull && (
                <AssistantDrawer
                    assistant={selectedFull}
                    onClose={() => setSelected(null)}
                    onReload={load}
                    isAdmin={isAdmin}
                />
            )}
        </div>
    );
}
