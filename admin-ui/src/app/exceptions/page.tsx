'use client';

import { useState, useEffect, useCallback } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/components/AuthProvider';
import {
    AlertTriangle, CheckCircle, Clock, X, Plus, Loader2,
    ChevronDown, ChevronUp, ShieldOff,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PolicyException {
    id: string;
    assistant_id: string | null;
    assistant_name: string | null;
    exception_type: string;
    justification: string;
    status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';
    expires_at: string;
    approved_by: string | null;
    approved_by_email: string | null;
    approved_by_name: string | null;
    approved_at: string | null;
    created_at: string;
}

interface Assistant {
    id: string;
    name: string;
    lifecycle_state: string;
    status: string;
}

const EXCEPTION_TYPES = [
    { value: 'allow_sensitive_topic', label: 'Permitir tópico sensível' },
    { value: 'bypass_hitl',           label: 'Dispensar aprovação humana' },
    { value: 'extend_token_limit',    label: 'Estender limite de tokens' },
    { value: 'custom',                label: 'Outro (especificar)' },
];

function daysUntilExpiry(expiresAt: string): number {
    return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
}

// ── Urgency badge ─────────────────────────────────────────────────────────────

function UrgencyBadge({ days }: { days: number }) {
    if (days <= 0)  return <span className="text-xs font-medium text-destructive">Expirado</span>;
    if (days < 7)   return <span className="text-xs font-medium text-destructive bg-destructive/10 px-2 py-0.5 rounded-full">⚠️ Expira em {days} dias!</span>;
    if (days <= 30) return <span className="text-xs font-medium text-warning-fg bg-warning-bg px-2 py-0.5 rounded-full">⚠️ Expira em {days} dias</span>;
    return <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">Expira em {days} dias</span>;
}

function leftBorderClass(days: number, status: string) {
    if (status !== 'approved') return '';
    if (days < 7)  return 'border-l-4 border-l-destructive';
    if (days <= 30) return 'border-l-4 border-l-amber-500';
    return 'border-l-4 border-l-emerald-500';
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ExceptionsPage() {
    const { role } = useAuth();
    const [exceptions, setExceptions]   = useState<PolicyException[]>([]);
    const [loading, setLoading]         = useState(true);
    const [tab, setTab]                 = useState<'active' | 'pending' | 'closed'>('active');
    const [error, setError]             = useState('');
    const [toast, setToast]             = useState('');

    // Revoke modal
    const [revokeId, setRevokeId]       = useState<string | null>(null);
    const [revokeReason, setRevokeReason] = useState('');
    const [revoking, setRevoking]       = useState(false);

    // New exception modal
    const [newModal, setNewModal]         = useState(false);
    const [assistants, setAssistants]     = useState<Assistant[]>([]);
    const [newAssistant, setNewAssistant] = useState('');
    const [newType, setNewType]           = useState('allow_sensitive_topic');
    const [newCustomType, setNewCustomType] = useState('');
    const [newJustification, setNewJustification] = useState('');
    const [newExpiry, setNewExpiry]       = useState('');
    const [submitting, setSubmitting]     = useState(false);

    // Expand justification
    const [expanded, setExpanded]         = useState<Record<string, boolean>>({});

    // Action loading
    const [actionId, setActionId]         = useState<string | null>(null);

    const canManage = ['admin', 'dpo'].includes(role ?? '');

    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(''), 3500);
    };

    const loadExceptions = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.POLICY_EXCEPTIONS);
            setExceptions(res.data);
        } catch {
            setError('Erro ao carregar exceções');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadExceptions(); }, [loadExceptions]);

    const loadAssistants = async () => {
        try {
            const res = await api.get(ENDPOINTS.ASSISTANTS);
            setAssistants((res.data as Assistant[]).filter(a =>
                ['official', 'approved', 'under_review', 'published', 'draft'].includes(a.lifecycle_state ?? a.status)
            ));
        } catch { /* silent */ }
    };

    const approve = async (id: string) => {
        setActionId(id);
        try {
            await api.post(ENDPOINTS.POLICY_EXCEPTION_APPROVE(id));
            showToast('Exceção aprovada');
            await loadExceptions();
        } catch {
            setError('Erro ao aprovar exceção');
        } finally {
            setActionId(null);
        }
    };

    const reject = async (id: string) => {
        setActionId(id);
        try {
            await api.post(ENDPOINTS.POLICY_EXCEPTION_REJECT(id));
            showToast('Exceção rejeitada');
            await loadExceptions();
        } catch {
            setError('Erro ao rejeitar exceção');
        } finally {
            setActionId(null);
        }
    };

    const revoke = async () => {
        if (!revokeId) return;
        setRevoking(true);
        try {
            await api.delete(ENDPOINTS.POLICY_EXCEPTION_REVOKE(revokeId), { data: { reason: revokeReason || undefined } });
            showToast('Exceção revogada');
            setRevokeId(null);
            setRevokeReason('');
            await loadExceptions();
        } catch {
            setError('Erro ao revogar exceção');
        } finally {
            setRevoking(false);
        }
    };

    const submitNew = async () => {
        const exceptionType = newType === 'custom' ? newCustomType.trim() : newType;
        if (!exceptionType || newJustification.trim().length < 20 || !newExpiry) return;
        setSubmitting(true);
        try {
            await api.post(ENDPOINTS.POLICY_EXCEPTIONS, {
                assistantId: newAssistant || null,
                exceptionType,
                justification: newJustification.trim(),
                expiresAt: new Date(newExpiry).toISOString(),
            });
            showToast('Solicitação de exceção criada');
            setNewModal(false);
            setNewAssistant(''); setNewType('allow_sensitive_topic'); setNewCustomType('');
            setNewJustification(''); setNewExpiry('');
            await loadExceptions();
        } catch {
            setError('Erro ao criar exceção');
        } finally {
            setSubmitting(false);
        }
    };

    // Filter by tab
    const now = Date.now();
    const activeList  = exceptions.filter(e => e.status === 'approved' && new Date(e.expires_at).getTime() > now);
    const pendingList = exceptions.filter(e => e.status === 'pending');
    const closedList  = exceptions.filter(e => ['rejected', 'revoked', 'expired'].includes(e.status) || (e.status === 'approved' && new Date(e.expires_at).getTime() <= now));

    const currentList = tab === 'active' ? activeList : tab === 'pending' ? pendingList : closedList;

    const minExpiry = new Date(now + 86400000).toISOString().split('T')[0];
    const maxExpiry = new Date(now + 365 * 86400000).toISOString().split('T')[0];

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-5">

                <PageHeader
                    title="Exceções de Política"
                    subtitle="Gestão de exceções temporárias às políticas de governança"
                    icon={<ShieldOff className="w-5 h-5" />}
                    actions={
                        <button
                            onClick={() => { loadAssistants(); setNewModal(true); }}
                            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                            Nova Exceção
                        </button>
                    }
                />

                {error && (
                    <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">{error}</div>
                )}

                {toast && (
                    <div className="fixed top-6 right-6 z-50 px-4 py-3 bg-emerald-600 text-white rounded-xl shadow-xl text-sm font-medium">
                        ✓ {toast}
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-1 p-1 bg-secondary/50 rounded-xl border border-border w-fit">
                    {[
                        { key: 'active',  label: 'Ativas',              count: activeList.length },
                        { key: 'pending', label: 'Pendentes',           count: pendingList.length },
                        { key: 'closed',  label: 'Expiradas/Revogadas', count: closedList.length },
                    ].map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key as any)}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                tab === t.key
                                    ? 'bg-card text-foreground shadow-sm border border-border'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            {t.label}
                            {t.count > 0 && (
                                <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
                                    t.key === 'pending' ? 'bg-warning-bg text-warning-fg' : 'bg-muted text-muted-foreground'
                                }`}>
                                    {t.count}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* List */}
                {loading ? (
                    <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="text-sm">Carregando...</span>
                    </div>
                ) : currentList.length === 0 ? (
                    <div className="flex flex-col items-center py-16 text-muted-foreground gap-3">
                        <CheckCircle className="w-10 h-10 opacity-30" />
                        <p className="text-sm">Nenhuma exceção {tab === 'active' ? 'ativa' : tab === 'pending' ? 'pendente' : 'encerrada'}</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {currentList.map(ex => {
                            const days = daysUntilExpiry(ex.expires_at);
                            const isExpanded = expanded[ex.id];
                            const longJustification = ex.justification.length > 100;

                            return (
                                <div
                                    key={ex.id}
                                    className={`bg-card border border-border rounded-xl p-5 space-y-3 ${leftBorderClass(days, ex.status)}`}
                                >
                                    {/* Header row */}
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="space-y-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-semibold text-sm">
                                                    {ex.assistant_name ?? 'Sem assistente'}
                                                </span>
                                                <span className="px-2 py-0.5 bg-muted text-muted-foreground rounded-full text-xs font-mono">
                                                    {ex.exception_type}
                                                </span>
                                                {ex.status === 'approved' && <UrgencyBadge days={days} />}
                                                {ex.status === 'pending' && (
                                                    <span className="px-2 py-0.5 bg-warning-bg text-warning-fg rounded-full text-xs font-medium">Pendente</span>
                                                )}
                                                {ex.status === 'rejected' && (
                                                    <span className="px-2 py-0.5 bg-destructive/10 text-destructive rounded-full text-xs font-medium">Rejeitada</span>
                                                )}
                                                {ex.status === 'revoked' && (
                                                    <span className="px-2 py-0.5 bg-muted text-muted-foreground rounded-full text-xs font-medium">Revogada</span>
                                                )}
                                            </div>

                                            {/* Justification */}
                                            <p className="text-sm text-muted-foreground">
                                                {isExpanded || !longJustification
                                                    ? `"${ex.justification}"`
                                                    : `"${ex.justification.substring(0, 100)}..."`}
                                                {longJustification && (
                                                    <button
                                                        onClick={() => setExpanded(e => ({ ...e, [ex.id]: !e[ex.id] }))}
                                                        className="ml-1 text-primary text-xs hover:underline inline-flex items-center gap-0.5"
                                                    >
                                                        {isExpanded ? (<><ChevronUp className="w-3 h-3" />ver menos</>) : (<><ChevronDown className="w-3 h-3" />ver mais</>)}
                                                    </button>
                                                )}
                                            </p>
                                        </div>

                                        {/* Actions */}
                                        {canManage && ex.status === 'pending' && (
                                            <div className="flex gap-2 shrink-0">
                                                <button
                                                    onClick={() => approve(ex.id)}
                                                    disabled={actionId === ex.id}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                                                >
                                                    {actionId === ex.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                                                    Aprovar
                                                </button>
                                                <button
                                                    onClick={() => reject(ex.id)}
                                                    disabled={actionId === ex.id}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-destructive/10 hover:bg-destructive/20 text-destructive rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                                                >
                                                    <X className="w-3 h-3" />
                                                    Rejeitar
                                                </button>
                                            </div>
                                        )}
                                        {canManage && ex.status === 'approved' && new Date(ex.expires_at).getTime() > now && (
                                            <button
                                                onClick={() => { setRevokeId(ex.id); setRevokeReason(''); }}
                                                className="shrink-0 px-3 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive transition-colors"
                                            >
                                                Revogar
                                            </button>
                                        )}
                                    </div>

                                    {/* Metadata */}
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground border-t border-border/50 pt-2">
                                        {ex.approved_by_email && (
                                            <span>Aprovado por: <span className="text-foreground">{ex.approved_by_email}</span>
                                                {ex.approved_at && ` em ${format(new Date(ex.approved_at), 'dd/MM/yyyy', { locale: ptBR })}`}
                                            </span>
                                        )}
                                        <span>Expira: <span className="text-foreground">{format(new Date(ex.expires_at), 'dd/MM/yyyy', { locale: ptBR })}</span></span>
                                        <span>Criado: {format(new Date(ex.created_at), 'dd/MM/yyyy', { locale: ptBR })}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Revoke modal */}
            {revokeId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/70 backdrop-blur-sm">
                    <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
                        <div className="flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-warning-fg" />
                            <h3 className="text-base font-semibold">Revogar Exceção</h3>
                        </div>
                        <p className="text-sm text-muted-foreground">Esta ação é imediata e não pode ser desfeita. A exceção será desativada.</p>
                        <div className="space-y-1">
                            <label className="text-sm font-medium">Motivo (opcional)</label>
                            <textarea
                                value={revokeReason}
                                onChange={e => setRevokeReason(e.target.value)}
                                placeholder="Descreva o motivo da revogação..."
                                rows={3}
                                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                            />
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => setRevokeId(null)} className="flex-1 px-4 py-2 bg-secondary border border-border rounded-lg text-sm font-medium hover:bg-secondary/80 transition-colors">
                                Cancelar
                            </button>
                            <button
                                onClick={revoke}
                                disabled={revoking}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-50"
                            >
                                {revoking ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                Confirmar Revogação
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* New exception modal */}
            {newModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/70 backdrop-blur-sm">
                    <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg font-semibold">Solicitar Nova Exceção</h3>
                            <button onClick={() => setNewModal(false)} className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="space-y-4">
                            {/* Assistente */}
                            <div className="space-y-1">
                                <label className="text-sm font-medium">Assistente</label>
                                <select
                                    value={newAssistant}
                                    onChange={e => setNewAssistant(e.target.value)}
                                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                >
                                    <option value="">Selecionar assistente...</option>
                                    {assistants.map(a => (
                                        <option key={a.id} value={a.id}>{a.name}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Tipo */}
                            <div className="space-y-1">
                                <label className="text-sm font-medium">Tipo de Exceção</label>
                                <select
                                    value={newType}
                                    onChange={e => setNewType(e.target.value)}
                                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                >
                                    {EXCEPTION_TYPES.map(t => (
                                        <option key={t.value} value={t.value}>{t.label}</option>
                                    ))}
                                </select>
                                {newType === 'custom' && (
                                    <input
                                        value={newCustomType}
                                        onChange={e => setNewCustomType(e.target.value)}
                                        placeholder="Descreva o tipo de exceção..."
                                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm mt-2 focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    />
                                )}
                            </div>

                            {/* Justificativa */}
                            <div className="space-y-1">
                                <label className="text-sm font-medium">
                                    Justificativa <span className="text-muted-foreground font-normal">(mín. 20 caracteres)</span>
                                </label>
                                <textarea
                                    value={newJustification}
                                    onChange={e => setNewJustification(e.target.value)}
                                    placeholder="Descreva o motivo de negócio para esta exceção..."
                                    rows={4}
                                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                                />
                                <div className={`text-xs text-right ${newJustification.length < 20 ? 'text-muted-foreground' : 'text-success-fg'}`}>
                                    {newJustification.length} / 20 mín.
                                </div>
                            </div>

                            {/* Expiração */}
                            <div className="space-y-1">
                                <label className="text-sm font-medium">Data de Expiração</label>
                                <input
                                    type="date"
                                    value={newExpiry}
                                    onChange={e => setNewExpiry(e.target.value)}
                                    min={minExpiry}
                                    max={maxExpiry}
                                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                />
                                <p className="text-xs text-muted-foreground">Máximo 365 dias no futuro.</p>
                            </div>
                        </div>

                        <div className="flex gap-3 pt-2">
                            <button onClick={() => setNewModal(false)} className="flex-1 px-4 py-2 bg-secondary border border-border rounded-lg text-sm font-medium hover:bg-secondary/80 transition-colors">
                                Cancelar
                            </button>
                            <button
                                onClick={submitNew}
                                disabled={submitting || newJustification.trim().length < 20 || !newExpiry || (newType === 'custom' && !newCustomType.trim())}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                            >
                                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                Solicitar Exceção
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
