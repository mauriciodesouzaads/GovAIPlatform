'use client';

import { useEffect, useState, useCallback } from 'react';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import {
    Eye, AlertTriangle, CheckCircle2, ShieldOff, RefreshCw,
    ScanEye, RotateCcw, Layers, Activity,
} from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import { Badge, riskBadge, findingBadge } from '@/components/Badge';

// ── Types ──────────────────────────────────────────────────────────────────

interface Posture {
    summary_score: number;
    open_findings: number;
    unresolved_critical: number;
    promoted_findings: number;
    accepted_risk: number;
    top_tools: { name: string; users: number }[];
    posture: { status: string; trend: string };
}
interface Finding {
    id: string; tool_name: string; tool_name_normalized: string;
    severity: string; status: string; risk_score: number;
    observation_count: number; unique_users: number;
    last_seen_at: string; promotion_candidate: boolean;
    owner_candidate: string | null;
}
interface Collector {
    id: string; source_kind: string; collector_id: string;
    health_status: string; last_success_at: string | null;
    failure_count: number; last_error: string | null;
}

// ── Color helpers ──────────────────────────────────────────────────────────

function severityColor(s: string) {
    switch (s) {
        case 'critical':      return 'text-danger-fg bg-danger-bg border-danger-border';
        case 'high':          return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
        case 'medium':        return 'text-warning-fg bg-warning-bg border-warning-border';
        case 'low':           return 'text-info-fg bg-info-bg border-info-border';
        default:              return 'text-gray-400 bg-gray-400/10 border-gray-400/20';
    }
}

function statusColor(s: string) {
    switch (s) {
        case 'open':          return 'text-warning-fg';
        case 'acknowledged':  return 'text-info-fg';
        case 'promoted':      return 'text-emerald-500';
        case 'accepted_risk': return 'text-gray-400';
        case 'dismissed':     return 'text-gray-500';
        case 'resolved':      return 'text-success-fg';
        default:              return 'text-gray-400';
    }
}

function healthColor(h: string) {
    switch (h) {
        case 'healthy':   return 'text-success-fg bg-success-bg border-success-border';
        case 'degraded':  return 'text-warning-fg bg-warning-bg border-warning-border';
        case 'error':     return 'text-danger-fg bg-danger-bg border-danger-border';
        default:          return 'text-gray-400 bg-gray-400/10 border-gray-400/20';
    }
}

function fmtDate(d: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// ── Modal for note-required actions ───────────────────────────────────────

function NoteModal({
    title, onConfirm, onCancel, loading,
}: {
    title: string;
    onConfirm: (note: string) => void;
    onCancel: () => void;
    loading: boolean;
}) {
    const [note, setNote] = useState('');
    useEscapeClose(onCancel);
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
        >
            <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md space-y-4">
                <h3 className="text-foreground font-bold text-lg">{title}</h3>
                <p className="text-muted-foreground text-sm">Justificativa Obrigatória</p>
                <textarea
                    className="w-full bg-secondary/50 border border-border rounded-lg p-3 text-foreground text-sm resize-none focus:outline-none focus:border-amber-400/50 placeholder:text-muted-foreground"
                    rows={4}
                    placeholder="Descreva o motivo (mínimo 20 caracteres)"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                />
                <div className="flex gap-3 justify-end">
                    <button onClick={onCancel}
                        className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors">
                        Cancelar
                    </button>
                    <button
                        onClick={() => onConfirm(note)}
                        disabled={note.trim().length < 20 || loading}
                        className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                        {loading ? 'Enviando…' : 'Confirmar'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function ShieldPage() {
    const { role, orgId } = useAuth();
    const { toast } = useToast();
    const isAdmin = role === 'admin';

    const [posture, setPosture] = useState<Posture | null>(null);
    const [findings, setFindings] = useState<Finding[]>([]);
    const [collectors, setCollectors] = useState<Collector[]>([]);
    const [loadingPosture, setLoadingPosture] = useState(true);
    const [loadingFindings, setLoadingFindings] = useState(true);
    const [loadingCollectors, setLoadingCollectors] = useState(true);
    const [generatingPosture, setGeneratingPosture] = useState(false);
    const [statusFilter, setStatusFilter] = useState('');
    const [severityFilter, setSeverityFilter] = useState('');
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [modal, setModal] = useState<{ type: 'accept_risk' | 'dismiss'; findingId: string } | null>(null);

    const fetchPosture = useCallback(async () => {
        if (!orgId) return; // wait for AuthProvider to resolve orgId
        setLoadingPosture(true);
        try {
            const res = await api.get(ENDPOINTS.SHIELD_POSTURE, { params: { orgId } });
            setPosture(res.data);
        } catch {
            // posture may be null on first run
        } finally {
            setLoadingPosture(false);
        }
    }, [orgId]);

    const fetchFindings = useCallback(async () => {
        if (!orgId) return; // wait for AuthProvider to resolve orgId
        setLoadingFindings(true);
        try {
            const params: Record<string, string> = { orgId };
            if (statusFilter) params.status = statusFilter;
            if (severityFilter) params.severity = severityFilter;
            const res = await api.get(ENDPOINTS.SHIELD_FINDINGS, { params });
            setFindings(res.data.findings || []);
        } catch {
            setFindings([]);
        } finally {
            setLoadingFindings(false);
        }
    }, [orgId, statusFilter, severityFilter]);

    const fetchCollectors = useCallback(async () => {
        if (!orgId) return; // wait for AuthProvider to resolve orgId
        setLoadingCollectors(true);
        try {
            const res = await api.get(ENDPOINTS.SHIELD_COLLECTOR_HEALTH, { params: { orgId } });
            setCollectors(res.data.collectors || []);
        } catch {
            setCollectors([]);
        } finally {
            setLoadingCollectors(false);
        }
    }, [orgId]);

    useEffect(() => { fetchPosture(); }, [fetchPosture]);
    useEffect(() => { fetchFindings(); }, [fetchFindings]);
    useEffect(() => { fetchCollectors(); }, [fetchCollectors]);

    const handleGeneratePosture = async () => {
        setGeneratingPosture(true);
        try {
            await api.post(ENDPOINTS.SHIELD_POSTURE_GENERATE, { orgId });
            toast('Postura gerada com sucesso.', 'success');
            fetchPosture();
        } catch {
            toast('Erro ao gerar postura.', 'error');
        } finally {
            setGeneratingPosture(false);
        }
    };

    const handleAcknowledge = async (id: string) => {
        setProcessingId(id);
        try {
            await api.post(ENDPOINTS.SHIELD_ACKNOWLEDGE(id), {});
            toast('Finding reconhecido.', 'success');
            setFindings(prev => prev.map(f => f.id === id ? { ...f, status: 'acknowledged' } : f));
        } catch {
            toast('Erro ao reconhecer finding.', 'error');
        } finally {
            setProcessingId(null);
        }
    };

    const handlePromote = async (id: string) => {
        setProcessingId(id);
        try {
            await api.post(ENDPOINTS.SHIELD_PROMOTE(id), {});
            toast('Finding promovido ao catálogo.', 'success');
            setFindings(prev => prev.map(f => f.id === id ? { ...f, status: 'promoted' } : f));
        } catch {
            toast('Erro ao promover finding.', 'error');
        } finally {
            setProcessingId(null);
        }
    };

    const handleNoteAction = async (note: string) => {
        if (!modal) return;
        setProcessingId(modal.findingId);
        try {
            const endpoint = modal.type === 'accept_risk'
                ? ENDPOINTS.SHIELD_ACCEPT_RISK(modal.findingId)
                : ENDPOINTS.SHIELD_DISMISS(modal.findingId);
            await api.post(endpoint, { note });
            toast(modal.type === 'accept_risk' ? 'Risco aceito formalmente.' : 'Finding dispensado.', 'success');
            const newStatus = modal.type === 'accept_risk' ? 'accepted_risk' : 'dismissed';
            setFindings(prev => prev.map(f => f.id === modal.findingId ? { ...f, status: newStatus } : f));
            setModal(null);
        } catch {
            toast('Erro ao processar ação.', 'error');
        } finally {
            setProcessingId(null);
        }
    };

    const handleSyncCatalog = async () => {
        try {
            await api.post(ENDPOINTS.SHIELD_SYNC_CATALOG, { orgId });
            toast('Catálogo sincronizado.', 'success');
        } catch {
            toast('Erro ao sincronizar catálogo.', 'error');
        }
    };

    const handleDedupe = async () => {
        try {
            await api.post(ENDPOINTS.SHIELD_DEDUPE, { orgId });
            toast('Deduplicação concluída.', 'success');
            fetchFindings();
        } catch {
            toast('Erro ao deduplicar.', 'error');
        }
    };

    // ── KPI helpers ────────────────────────────────────────────────────────
    const kpiShadowAIs = posture?.open_findings     ?? null;
    const kpiScore     = posture?.summary_score     ?? null;
    const kpiCritical  = posture?.unresolved_critical ?? null;

    const scoreColor = kpiScore == null ? 'text-foreground'
        : kpiScore >= 70 ? 'text-green-500'
        : kpiScore >= 40 ? 'text-warning-fg'
        : 'text-danger-fg';

    return (
        <div className="flex-1 overflow-auto">

            {modal && (
                <NoteModal
                    title={modal.type === 'accept_risk' ? 'Aceitar Risco' : 'Dispensar Finding'}
                    onConfirm={handleNoteAction}
                    onCancel={() => setModal(null)}
                    loading={processingId === modal.findingId}
                />
            )}

            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
                <PageHeader
                    title="Shield Detection"
                    subtitle="Detecção de uso não autorizado de IA"
                    icon={<ScanEye className="w-5 h-5" />}
                />

                {/* ── Hero KPIs ── */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* KPI 1 — Shadow AIs */}
                    <div className="bg-card border border-border rounded-xl p-6 flex flex-col gap-2">
                        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Shadow AIs Detectadas</p>
                        {loadingPosture ? (
                            <div className="animate-pulse space-y-2">
                                <div className="h-9 w-16 bg-muted rounded" />
                                <div className="h-4 w-28 bg-muted rounded" />
                            </div>
                        ) : (
                            <>
                                <div className="text-3xl font-bold text-foreground">{kpiShadowAIs ?? '—'}</div>
                                <p className="text-xs text-muted-foreground">ferramentas com findings ativos</p>
                            </>
                        )}
                    </div>

                    {/* KPI 2 — Posture Score */}
                    <div className="bg-card border border-border rounded-xl p-6 flex flex-col gap-2">
                        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Posture Score</p>
                        {loadingPosture ? (
                            <div className="animate-pulse space-y-2">
                                <div className="h-9 w-24 bg-muted rounded" />
                                <div className="h-4 w-32 bg-muted rounded" />
                            </div>
                        ) : (
                            <>
                                <div className={`text-3xl font-bold ${scoreColor}`}>
                                    {kpiScore != null ? `${kpiScore} / 100` : '—'}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {kpiScore == null ? 'sem snapshot disponível'
                                        : kpiScore >= 70 ? 'postura saudável'
                                        : kpiScore >= 40 ? 'atenção necessária'
                                        : 'postura crítica — ação imediata'}
                                </p>
                            </>
                        )}
                    </div>

                    {/* KPI 3 — Critical + High Open */}
                    <div className="bg-card border border-border rounded-xl p-6 flex flex-col gap-2">
                        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Findings Abertos (Críticos + Alto)</p>
                        {loadingPosture ? (
                            <div className="animate-pulse space-y-2">
                                <div className="h-9 w-12 bg-muted rounded" />
                                <div className="h-4 w-36 bg-muted rounded" />
                            </div>
                        ) : (
                            <>
                                <div className={`text-3xl font-bold ${(kpiCritical ?? 0) > 0 ? 'text-danger-fg' : 'text-foreground'}`}>
                                    {kpiCritical ?? '—'}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {kpiCritical == null ? 'sem dados' : kpiCritical === 0 ? 'nenhum finding crítico aberto' : 'requerem ação imediata'}
                                </p>
                            </>
                        )}
                    </div>
                </div>

                {/* CTA */}
                <div className="flex items-center justify-end">
                    <a
                        href="/reports"
                        className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                    >
                        Gerar Relatório de Compliance
                    </a>
                </div>

                {/* Section A — Posture Cards */}
                {loadingPosture ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-pulse">
                        {[1, 2, 3, 4].map(i => <div key={i} className="h-28 bg-secondary/50 border border-border rounded-2xl" />)}
                    </div>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {/* Card 1 */}
                        <div className="bg-card border border-border rounded-2xl p-5 hover:border-border transition-all">
                            <div className="w-9 h-9 rounded-xl bg-warning-bg border border-warning-border flex items-center justify-center mb-3">
                                <Eye className="w-4.5 h-4.5 text-warning-fg" />
                            </div>
                            <div className="text-2xl font-semibold text-foreground">{posture?.open_findings ?? 0}</div>
                            <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mt-1">Ferramentas Detectadas</p>
                            <p className="text-xs text-amber-400/70 mt-0.5">findings ativos</p>
                        </div>
                        {/* Card 2 */}
                        <div className="bg-gradient-to-br from-rose-950/40 to-background border border-danger-border rounded-2xl p-5 hover:border-danger-border transition-all relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-20 h-20 bg-danger-bg blur-2xl pointer-events-none" />
                            <div className="w-9 h-9 rounded-xl bg-danger-bg border border-danger-border flex items-center justify-center mb-3">
                                <AlertTriangle className="w-4.5 h-4.5 text-danger-fg" />
                            </div>
                            <div className="text-2xl font-semibold text-foreground">{posture?.unresolved_critical ?? 0}</div>
                            <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mt-1">Risco Crítico</p>
                            <p className="text-xs text-rose-400/70 mt-0.5">requerem ação imediata</p>
                        </div>
                        {/* Card 3 */}
                        <div className="bg-card border border-border rounded-2xl p-5 hover:border-border transition-all">
                            <div className="w-9 h-9 rounded-xl bg-success-bg border border-success-border flex items-center justify-center mb-3">
                                <CheckCircle2 className="w-4.5 h-4.5 text-emerald-500" />
                            </div>
                            <div className="text-2xl font-semibold text-foreground">{posture?.promoted_findings ?? 0}</div>
                            <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mt-1">Em Governança</p>
                            <p className="text-xs text-emerald-400/70 mt-0.5">promovidos ao catálogo</p>
                        </div>
                        {/* Card 4 */}
                        <div className="bg-card border border-border rounded-2xl p-5 hover:border-border transition-all">
                            <div className="w-9 h-9 rounded-xl bg-gray-400/10 border border-gray-400/20 flex items-center justify-center mb-3">
                                <ShieldOff className="w-4.5 h-4.5 text-gray-400" />
                            </div>
                            <div className="text-2xl font-semibold text-foreground">{posture?.accepted_risk ?? 0}</div>
                            <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mt-1">Risco Aceito</p>
                            <p className="text-xs text-gray-400/70 mt-0.5">aceitos formalmente</p>
                        </div>
                    </div>
                )}

                {/* Section B — Top Tools */}
                {posture?.top_tools && posture.top_tools.length > 0 && (
                    <div className="bg-card border border-border rounded-2xl p-5">
                        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
                            <Activity className="w-4 h-4 text-warning-fg" />
                            Top Ferramentas em Risco
                        </h2>
                        <div className="flex flex-wrap gap-3">
                            {posture.top_tools.map((t, i) => (
                                <div key={i} className="flex items-center gap-3 bg-secondary/50 border border-border rounded-xl px-3 py-2">
                                    <span className="text-sm font-semibold text-foreground capitalize">{t.name}</span>
                                    <span className="text-xs text-warning-fg font-bold">{t.users} usuários</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Section C — Findings Table */}
                <div className="bg-card border border-border rounded-2xl overflow-hidden">
                    <div className="p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
                            <Layers className="w-4 h-4 text-warning-fg" />
                            Findings de Detecção
                        </h2>
                        <div className="flex flex-wrap items-center gap-2">
                            <select
                                value={statusFilter}
                                onChange={e => setStatusFilter(e.target.value)}
                                className="bg-secondary/50 border border-border text-foreground text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-amber-400/50">
                                <option value="">Todos os Status</option>
                                <option value="open">open</option>
                                <option value="acknowledged">acknowledged</option>
                                <option value="promoted">promoted</option>
                                <option value="accepted_risk">accepted_risk</option>
                                <option value="dismissed">dismissed</option>
                            </select>
                            <select
                                value={severityFilter}
                                onChange={e => setSeverityFilter(e.target.value)}
                                className="bg-secondary/50 border border-border text-foreground text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-amber-400/50">
                                <option value="">Todas as Severidades</option>
                                <option value="critical">critical</option>
                                <option value="high">high</option>
                                <option value="medium">medium</option>
                                <option value="low">low</option>
                                <option value="informational">informational</option>
                            </select>
                            {isAdmin && (
                                <>
                                    <button onClick={handleSyncCatalog}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-info-bg hover:bg-info-bg text-info-fg border border-info-border rounded-lg text-xs font-semibold transition-all">
                                        <RotateCcw className="w-3 h-3" /> Sincronizar Catálogo
                                    </button>
                                    <button onClick={handleDedupe}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border border-purple-500/20 rounded-lg text-xs font-semibold transition-all">
                                        <Layers className="w-3 h-3" /> Deduplicar
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    {loadingFindings ? (
                        <div className="p-5 space-y-2 animate-pulse">
                            {[1, 2, 3].map(i => <div key={i} className="h-10 bg-secondary/50 rounded-lg" />)}
                        </div>
                    ) : findings.length === 0 ? (
                        <div className="p-10 text-center text-muted-foreground text-sm">
                            Nenhum finding encontrado com os filtros atuais.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-xs text-muted-foreground uppercase tracking-wider border-b border-border/50">
                                        <th className="px-4 py-3 text-left">Ferramenta</th>
                                        <th className="px-4 py-3 text-left">Severidade</th>
                                        <th className="px-4 py-3 text-left">Status</th>
                                        <th className="px-4 py-3 text-right">Score</th>
                                        <th className="px-4 py-3 text-right">Obs.</th>
                                        <th className="px-4 py-3 text-right">Usuários</th>
                                        <th className="px-4 py-3 text-left">Última Detecção</th>
                                        {isAdmin && <th className="px-4 py-3 text-right">Ações</th>}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border/30">
                                    {findings.map(f => (
                                        <tr key={f.id} className="hover:bg-secondary/20 transition-colors">
                                            <td className="px-4 py-3 font-semibold text-foreground capitalize">{f.tool_name}</td>
                                            <td className="px-4 py-3">
                                                <span className={`text-xs font-semibold uppercase tracking-widest rounded px-1.5 py-0.5 border ${severityColor(f.severity)}`}>
                                                    {f.severity}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`text-xs font-semibold ${statusColor(f.status)}`}>{f.status}</span>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className="text-warning-fg font-bold">{f.risk_score}</span>
                                            </td>
                                            <td className="px-4 py-3 text-right text-muted-foreground">{f.observation_count}</td>
                                            <td className="px-4 py-3 text-right text-muted-foreground">{f.unique_users}</td>
                                            <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(f.last_seen_at)}</td>
                                            {isAdmin && (
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                                                        {f.status === 'open' && (
                                                            <button
                                                                onClick={() => handleAcknowledge(f.id)}
                                                                disabled={processingId === f.id}
                                                                className="px-2 py-1 text-xs font-bold bg-info-bg hover:bg-info-bg text-info-fg border border-info-border rounded-lg transition-all disabled:opacity-40">
                                                                Acknowledger
                                                            </button>
                                                        )}
                                                        {f.promotion_candidate && f.status !== 'promoted' && (
                                                            <button
                                                                onClick={() => handlePromote(f.id)}
                                                                disabled={processingId === f.id}
                                                                className="px-2 py-1 text-xs font-bold bg-success-bg hover:bg-success-bg text-success-fg border border-success-border rounded-lg transition-all disabled:opacity-40">
                                                                Promover
                                                            </button>
                                                        )}
                                                        {!['accepted_risk', 'dismissed', 'resolved'].includes(f.status) && (
                                                            <button
                                                                onClick={() => setModal({ type: 'accept_risk', findingId: f.id })}
                                                                className="px-2 py-1 text-xs font-bold bg-gray-400/10 hover:bg-gray-400/20 text-gray-400 border border-gray-400/20 rounded-lg transition-all">
                                                                Aceitar Risco
                                                            </button>
                                                        )}
                                                        {!['dismissed', 'resolved'].includes(f.status) && (
                                                            <button
                                                                onClick={() => setModal({ type: 'dismiss', findingId: f.id })}
                                                                className="px-2 py-1 text-xs font-bold bg-danger-bg hover:bg-danger-bg text-danger-fg border border-danger-border rounded-lg transition-all">
                                                                Dispensar
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Section D — Collector Health */}
                <div className="bg-card border border-border rounded-2xl p-5">
                    <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
                        <Activity className="w-4 h-4 text-warning-fg" />
                        Health dos Collectors
                    </h2>
                    {loadingCollectors ? (
                        <div className="flex gap-3 animate-pulse">
                            {[1, 2, 3].map(i => <div key={i} className="h-16 w-48 bg-secondary/50 rounded-xl" />)}
                        </div>
                    ) : collectors.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Nenhum collector configurado.</p>
                    ) : (
                        <div className="flex flex-wrap gap-3">
                            {collectors.map(c => (
                                <div key={c.id} className="bg-secondary/50 border border-border rounded-xl px-4 py-3 min-w-[200px]">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-xs font-bold text-foreground uppercase tracking-wide">{c.source_kind}</span>
                                        <span className={`text-xs font-semibold uppercase tracking-widest rounded px-1.5 py-0.5 border ${healthColor(c.health_status)}`}>
                                            {c.health_status}
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{fmtDate(c.last_success_at)}</p>
                                    {c.failure_count > 0 && (
                                        <p className="text-xs text-danger-fg mt-0.5">{c.failure_count} falha(s)</p>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
