'use client';

import { useEffect, useState, useCallback } from 'react';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import {
    BookOpen, ChevronRight, X, Tag, Calendar, User,
    AlertTriangle, CheckCircle2, Clock, Loader2, ExternalLink,
    Archive, ShieldAlert, Link2, Copy, FileCheck,
    Grid3X3, ShieldCheck, Star, History,
} from 'lucide-react';
import Link from 'next/link';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import { Badge, lifecycleBadge, riskBadge } from '@/components/Badge';
import { ExitPerimeterModal } from '@/components/ExitPerimeterModal';
import { ReviewTracksPanel } from '@/components/ReviewTracksPanel';

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
    version_label?: string;
    change_type?: string;
    risk_score?: number;
    risk_breakdown?: Record<string, unknown>;
    risk_computed_at?: string;
    data_classification?: string;
    pii_blocker_enabled?: boolean;
    output_format?: string;
    is_favorited?: boolean;
    last_used_at?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function lifecycleColor(s?: string) {
    switch (s) {
        case 'approved':        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'official':        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'under_review':    return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'draft':           return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
        case 'suspended':       return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        case 'archived':        return 'text-muted-foreground bg-gray-500/10 border-gray-500/20';
        default:                return 'text-muted-foreground bg-gray-400/10 border-gray-400/20';
    }
}

function riskColor(r?: string) {
    switch (r) {
        case 'critical':    return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        case 'high':        return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
        case 'medium':      return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'low':         return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        default:            return 'text-muted-foreground bg-gray-400/10 border-gray-400/20';
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
    useEscapeClose(onClose);
    const canConfirm = !inputRequired || value.trim().length >= inputMin;

    return (
        <>
            <div className="fixed inset-0 bg-background/70 backdrop-blur-sm z-[60]" onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center z-[70] p-4" role="dialog" aria-modal="true">
                <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl space-y-4">
                    <div className="flex items-start justify-between">
                        <h3 className="font-semibold text-foreground text-base">{title}</h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="text-sm text-muted-foreground">{description}</p>
                    {inputLabel && (
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                {inputLabel}
                            </label>
                            <textarea
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                rows={3}
                                className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-gray-600 focus:outline-none focus:border-amber-500/50 resize-none"
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
                            className="px-4 py-2 rounded-lg text-sm border border-border text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors disabled:opacity-50"
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
    onOpenExitModal: (a: Assistant) => void;
}

function AssistantDrawer({ assistant: initialAssistant, onClose, onReload, isAdmin, onOpenExitModal }: DrawerProps) {
    const [tab, setTab] = useState<DrawerTab>('details');
    const [assistant, setAssistant] = useState(initialAssistant);
    const [actionLoading, setActionLoading] = useState(false);
    const [modal, setModal] = useState<null | { type: 'approve' | 'reject' | 'suspend' | 'archive' }>(null);
    const { toast } = useToast();
    const { token, orgId } = useAuth();
    useEscapeClose(onClose, modal === null);

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
            <div className="fixed inset-0 bg-background/70 backdrop-blur-sm z-40" onClick={onClose} />

            {/* Panel */}
            <aside role="dialog" aria-modal="true" aria-labelledby="drawer-title" className="fixed right-0 top-0 h-full w-full max-w-lg bg-card border-l border-border z-50 flex flex-col overflow-hidden shadow-2xl">

                {/* Header */}
                <div className="flex items-start justify-between p-6 border-b border-border">
                    <div>
                        <h2 id="drawer-title" className="text-lg font-semibold text-foreground">{assistant.name}</h2>
                        <p className="text-sm text-muted-foreground mt-0.5">{assistant.id}</p>
                    </div>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-border">
                    {tabs.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                                tab === t.key
                                    ? 'border-amber-500 text-amber-400'
                                    : 'border-transparent text-muted-foreground hover:text-foreground/80'
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
                                {assistant.risk_score !== undefined && (
                                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${riskColor(assistant.risk_level)}`}>
                                        Score: {assistant.risk_score}
                                    </span>
                                )}
                                {assistant.model && (
                                    <span className="px-2.5 py-1 rounded-full text-xs font-medium border text-purple-400 bg-purple-500/10 border-purple-500/20">
                                        {assistant.model}
                                    </span>
                                )}
                            </div>

                            {assistant.description && (
                                <div>
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Descrição</p>
                                    <p className="text-sm text-foreground/80">{assistant.description}</p>
                                </div>
                            )}

                            {assistant.risk_justification && (
                                <div>
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Justificativa de Risco</p>
                                    <p className="text-sm text-foreground/80">{assistant.risk_justification}</p>
                                </div>
                            )}

                            {assistant.capability_tags && assistant.capability_tags.length > 0 && (
                                <div>
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Capability Tags</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {assistant.capability_tags.map(tag => (
                                            <span key={tag} className="px-2 py-0.5 rounded text-xs bg-secondary/50 border border-border text-foreground/80">
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Owner</p>
                                    <p className="text-sm text-foreground/80 flex items-center gap-1.5">
                                        <User className="w-3.5 h-3.5 text-muted-foreground" />
                                        {assistant.owner_email ?? '—'}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Versões</p>
                                    <p className="text-sm text-foreground/80 flex items-center gap-2">
                                        {assistant.version_count ?? 0}
                                        {assistant.version_label && assistant.version_label !== '..' && (
                                            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-secondary border border-border text-muted-foreground">
                                                v{assistant.version_label}
                                            </span>
                                        )}
                                        {assistant.change_type && (
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium
                                                ${assistant.change_type === 'major' ? 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                                                  : assistant.change_type === 'minor' ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                                                  : 'bg-secondary border-border text-muted-foreground'}`}>
                                                {assistant.change_type}
                                            </span>
                                        )}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Revisado em</p>
                                    <p className="text-sm text-foreground/80 flex items-center gap-1.5">
                                        <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />
                                        {fmtDate(assistant.reviewed_at)}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Criado em</p>
                                    <p className="text-sm text-foreground/80 flex items-center gap-1.5">
                                        <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
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
                            <div className="bg-card/30 border border-border rounded-xl p-4">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Estado atual</p>
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
                                            Aprovar (legacy)
                                        </button>
                                        <button
                                            onClick={() => setModal({ type: 'reject' })}
                                            disabled={actionLoading}
                                            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-rose-500/50 text-rose-400 hover:bg-rose-500/10 font-semibold text-sm transition-colors disabled:opacity-50"
                                        >
                                            <AlertTriangle className="w-4 h-4" />
                                            Rejeitar (legacy)
                                        </button>
                                        <div className="pt-1">
                                            <p className="text-xs text-muted-foreground font-medium mb-2">Tracks de Revisão</p>
                                            <ReviewTracksPanel
                                                assistantId={assistant.id}
                                                orgId={orgId}
                                                token={token ?? ''}
                                                canDecide={isAdmin}
                                                onDecisionMade={() => {
                                                    onReload();
                                                    // Refresh local state after a track decision
                                                    setAssistant(a => ({ ...a }));
                                                }}
                                            />
                                        </div>
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
                                    <div className="text-xs text-muted-foreground bg-secondary/30 border border-border/50 rounded-lg p-3 leading-relaxed">
                                        Para publicar como <strong className="text-foreground">oficial</strong>, publique uma versão do assistente
                                        na página{' '}
                                        <a href="/assistants" className="text-amber-400 hover:underline">Assistentes</a>.
                                    </div>
                                )}

                                {state === 'suspended' && (
                                    <button
                                        onClick={() => setModal({ type: 'archive' })}
                                        disabled={actionLoading}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-500/50 text-muted-foreground hover:bg-gray-500/10 font-semibold text-sm transition-colors disabled:opacity-50"
                                    >
                                        <Archive className="w-4 h-4" />
                                        Arquivar
                                    </button>
                                )}

                                {state === 'archived' && (
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground bg-secondary/30 border border-border/50 rounded-lg p-4">
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
                                        <p className="text-sm font-semibold text-foreground">Link Governado</p>
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        Compartilhe este link com usuários finais. Adicione uma API Key válida ao final.
                                    </p>
                                    <div className="bg-card/30 border border-border rounded-lg p-3 font-mono text-xs text-muted-foreground break-all">
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
                                    <div className="border-t border-border/50 pt-3" />
                                </div>
                            ) : (
                                <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/30 border border-border/50 rounded-lg p-3">
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600/70" />
                                    Assistente deve estar com status <strong className="text-foreground mx-1">official</strong>
                                    para gerar link de acesso externo.
                                </div>
                            )}

                            {/* Governed chat button */}
                            <div className="space-y-2">
                                {state === 'official' ? (
                                    <a
                                        href={`/chat/${assistant.id}?key=`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-foreground font-semibold text-sm transition-colors"
                                    >
                                        <ExternalLink className="w-4 h-4" />
                                        Abrir Chat Governado ↗
                                    </a>
                                ) : (
                                    <div title="Assistente deve estar com status 'Oficial' para abrir o chat governado.">
                                        <button
                                            disabled
                                            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600/30 text-emerald-700 font-semibold text-sm cursor-not-allowed opacity-50"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                            Abrir Chat Governado ↗
                                        </button>
                                        <p className="text-xs text-muted-foreground mt-1 text-center">
                                            Requer status <strong className="text-muted-foreground">oficial</strong>
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Evidence link */}
                            <Link
                                href={`/evidence/${assistant.id}`}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-white/20 text-sm font-medium transition-colors"
                            >
                                <FileCheck className="w-4 h-4" />
                                Ver Evidência de Conformidade
                            </Link>

                            {/* Modo 2: Abrir na Origem */}
                            {state === 'official' && (
                                <div className="border-t border-border pt-4 mt-2">
                                    <p className="text-xs text-muted-foreground mb-2">
                                        Execução fora do ambiente governado
                                    </p>
                                    <button
                                        onClick={() => onOpenExitModal(assistant)}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 text-sm font-medium transition-colors"
                                    >
                                        <ExternalLink className="w-4 h-4" />
                                        Abrir na Origem ↗
                                    </button>
                                    <p className="text-[11px] text-amber-500/60 mt-1 text-center">
                                        Dados não serão auditados nem mascarados
                                    </p>
                                </div>
                            )}

                            {/* Playground admin link */}
                            <div className="space-y-2">
                                <p className="text-xs text-muted-foreground">Teste no Playground com o pipeline completo (OPA + DLP + HITL).</p>
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
                    confirmClass="bg-rose-500 hover:bg-rose-400 text-foreground"
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
                    confirmClass="border border-gray-500/50 text-muted-foreground hover:bg-gray-500/10"
                    onConfirm={reason => doArchive(reason)}
                    onClose={() => setModal(null)}
                    loading={actionLoading}
                />
            )}
        </>
    );
}

// ── Card ───────────────────────────────────────────────────────────────────

function AssistantCard({ assistant, onManage, onToggleFavorite }: {
    assistant: Assistant;
    onManage: () => void;
    onToggleFavorite?: (a: Assistant, e: React.MouseEvent) => void;
}) {
    return (
        <div className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4 hover:border-amber-500/30 hover:bg-secondary/30 transition-all relative">
            {/* Favorite button */}
            {onToggleFavorite && (
                <button
                    onClick={e => { e.stopPropagation(); onToggleFavorite(assistant, e); }}
                    className={`absolute top-3 right-3 p-1 rounded transition-colors ${
                        assistant.is_favorited
                            ? 'text-amber-400 hover:text-amber-300'
                            : 'text-muted-foreground/40 hover:text-amber-400'
                    }`}
                    title={assistant.is_favorited ? 'Remover favorito' : 'Adicionar favorito'}
                >
                    <Star className="w-4 h-4" fill={assistant.is_favorited ? 'currentColor' : 'none'} />
                </button>
            )}
            {/* Top row */}
            <div className="flex items-start justify-between gap-3 pr-6">
                <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground text-sm leading-snug truncate">{assistant.name}</h3>
                    {assistant.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{assistant.description}</p>
                    )}
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            </div>

            {/* Badges */}
            <div className="flex flex-wrap gap-1.5">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${lifecycleColor(assistant.lifecycle_state)}`}>
                    {assistant.lifecycle_state ?? 'draft'}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${riskColor(assistant.risk_level)}`}>
                    {assistant.risk_level ?? 'low'}
                </span>
                {assistant.risk_score !== undefined && (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${riskColor(assistant.risk_level)}`}>
                        {assistant.risk_score}pts
                    </span>
                )}
            </div>

            {/* Capability tags (up to 3 + overflow) */}
            {assistant.capability_tags && assistant.capability_tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {assistant.capability_tags.slice(0, 3).map(tag => (
                        <span key={tag} className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-secondary/50 border border-border text-muted-foreground">
                            <Tag className="w-2.5 h-2.5" />{tag}
                        </span>
                    ))}
                    {assistant.capability_tags.length > 3 && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-secondary/50 border border-border text-muted-foreground/70">
                            +{assistant.capability_tags.length - 3}
                        </span>
                    )}
                </div>
            )}

            {/* Meta footer */}
            <div className="flex items-center justify-between text-[10px] text-muted-foreground border-t border-border/50 pt-3">
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

type CatalogTab = 'all' | 'official' | 'favorites' | 'recent';

const CATALOG_TABS: { key: CatalogTab; label: string; icon: React.ReactNode }[] = [
    { key: 'all',       label: 'Todos',     icon: <Grid3X3 className="w-3.5 h-3.5" /> },
    { key: 'official',  label: 'Oficiais',  icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    { key: 'favorites', label: 'Favoritos', icon: <Star className="w-3.5 h-3.5" /> },
    { key: 'recent',    label: 'Recentes',  icon: <History className="w-3.5 h-3.5" /> },
];

export default function CatalogPage() {
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [lifecycleFilter, setLifecycleFilter] = useState('all');
    const [riskFilter, setRiskFilter] = useState('all');
    const [activeTab, setActiveTab] = useState<CatalogTab>('all');
    const [selected, setSelected] = useState<Assistant | null>(null);
    const [exitModalAssistant, setExitModalAssistant] = useState<Assistant | null>(null);
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

    const toggleFavorite = useCallback(async (a: Assistant, e: React.MouseEvent) => {
        e.stopPropagation();
        const wasFav = !!a.is_favorited;
        // Optimistic update
        setAssistants(prev => prev.map(x => x.id === a.id ? { ...x, is_favorited: !wasFav } : x));
        try {
            if (wasFav) {
                await api.delete(ENDPOINTS.ASSISTANT_FAVORITE(a.id));
            } else {
                await api.post(ENDPOINTS.ASSISTANT_FAVORITE(a.id));
            }
        } catch (err: any) {
            // Revert on failure
            setAssistants(prev => prev.map(x => x.id === a.id ? { ...x, is_favorited: wasFav } : x));
            toast(err.response?.data?.error ?? err.message, 'error');
        }
    }, [toast]);

    const filtered = assistants.filter(a => {
        const matchSearch = !search ||
            a.name.toLowerCase().includes(search.toLowerCase()) ||
            (a.description ?? '').toLowerCase().includes(search.toLowerCase()) ||
            (a.owner_email ?? '').toLowerCase().includes(search.toLowerCase());
        const matchLifecycle = lifecycleFilter === 'all' || (a.lifecycle_state ?? 'draft') === lifecycleFilter;
        const matchRisk = riskFilter === 'all' || (a.risk_level ?? 'low') === riskFilter;
        const matchTab = activeTab === 'all' ? true
            : activeTab === 'official' ? (a.lifecycle_state === 'official' || a.lifecycle_state === 'approved')
            : activeTab === 'favorites' ? !!a.is_favorited
            : activeTab === 'recent' ? !!a.last_used_at
            : true;
        return matchSearch && matchLifecycle && matchRisk && matchTab;
    });

    // When drawer reloads, keep selected in sync with refreshed assistants list
    const selectedFull = selected ? (assistants.find(a => a.id === selected.id) ?? selected) : null;

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">

                <PageHeader
                    title="Catálogo de Agentes"
                    subtitle="Registry formal de capacidades de IA"
                    icon={<BookOpen className="w-5 h-5" />}
                />

                {/* Tabs */}
                <div className="flex border-b border-border gap-1">
                    {CATALOG_TABS.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setActiveTab(t.key)}
                            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                                activeTab === t.key
                                    ? 'border-amber-500 text-amber-400'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            {t.icon}{t.label}
                        </button>
                    ))}
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-3">
                    <input
                        type="text"
                        placeholder="Buscar por nome, descrição ou owner..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-amber-500/50"
                    />
                    <div className="flex gap-2 flex-wrap">
                        {LIFECYCLE_FILTERS.map(f => (
                            <button
                                key={f}
                                onClick={() => setLifecycleFilter(f)}
                                className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                                    lifecycleFilter === f
                                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                                        : 'border-border text-muted-foreground hover:text-foreground'
                                }`}
                            >
                                {f === 'all' ? 'Todos' : f}
                            </button>
                        ))}
                        <div className="w-px bg-border self-stretch mx-1" />
                        {RISK_FILTERS.map(f => (
                            <button
                                key={f}
                                onClick={() => setRiskFilter(f)}
                                className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                                    riskFilter === f
                                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                                        : 'border-border text-muted-foreground hover:text-foreground'
                                }`}
                            >
                                {f === 'all' ? 'Todos riscos' : f}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Summary bar */}
                <p className="text-xs text-muted-foreground">
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
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {[1,2,3,4,5,6].map(i => (
                            <div key={i} className="bg-card border border-border rounded-xl p-5 space-y-3">
                                <div className="h-5 bg-secondary/60 rounded animate-pulse w-3/4" />
                                <div className="h-4 bg-secondary/60 rounded animate-pulse w-full" />
                                <div className="h-4 bg-secondary/60 rounded animate-pulse w-2/3" />
                            </div>
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
                        <BookOpen className="w-10 h-10 opacity-30" />
                        <p className="text-sm">Nenhum assistente encontrado com os filtros selecionados.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {filtered.map(a => (
                            <AssistantCard key={a.id} assistant={a} onManage={() => setSelected(a)} onToggleFavorite={toggleFavorite} />
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
                    onOpenExitModal={setExitModalAssistant}
                />
            )}

            {/* Exit Perimeter Modal */}
            <ExitPerimeterModal
                open={!!exitModalAssistant}
                onClose={() => setExitModalAssistant(null)}
                assistant={exitModalAssistant ?? { id: '', name: '' }}
                targetUrl="https://chatgpt.com"
            />
        </div>
    );
}
