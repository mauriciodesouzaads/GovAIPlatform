'use client';

import { useState, useEffect, useCallback } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import { Clock, CheckCircle, XCircle, AlertTriangle, Loader2, ShieldAlert, UserCircle, MessageSquare, Database } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';
import { Badge, approvalBadge, riskBadge } from '@/components/Badge';

interface Approval {
    id: string;
    assistant_id: string;
    assistant_name: string;
    message: string;
    policy_reason: string;
    trace_id: string;
    status: string;
    reviewer_email: string | null;
    review_note: string | null;
    reviewed_at: string | null;
    created_at: string;
    risk_level?: 'low' | 'medium' | 'high';
    justification?: string;
}


export default function ApprovalsPage() {
    const [approvals, setApprovals] = useState<Approval[]>([]);
    const [loading, setLoading] = useState(true);
    const [processing, setProcessing] = useState<string | null>(null);
    const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
    const [rejectNote, setRejectNote] = useState('');
    const [showRejectModal, setShowRejectModal] = useState<string | null>(null);

    const { toast } = useToast();

    const fetchApprovals = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(ENDPOINTS.APPROVALS, { params: { status: tab } });
            setApprovals(res.data);
        } catch (err: unknown) {
            const errorMsg = (err as { response?: { data?: { error?: string } } }).response?.data?.error || 'Erro ao buscar aprovações';
            toast(errorMsg, 'error');
        } finally {
            setLoading(false);
        }
    }, [tab, toast]);

    useEffect(() => { fetchApprovals(); }, [fetchApprovals]);

    const handleApprove = async (id: string) => {
        setProcessing(id);
        try {
            const res = await api.post(`${ENDPOINTS.APPROVALS}/${id}/approve`, { reviewNote: 'Aprovado' });
            toast(`Decisão aprovada! Trace: ${res.data._govai?.traceId || id.substring(0, 8)}`, 'success');
            // Optimistic update: remove from current list if in pending tab
            if (tab === 'pending') {
                setApprovals((prev: Approval[]) => prev.filter((a: Approval) => a.id !== id));
            } else {
                fetchApprovals();
            }
        } catch (err: unknown) {
            const axiosError = err as { response?: { data?: { error?: string } } };
            toast(axiosError.response?.data?.error || 'Erro ao aprovar a transação', 'error');
        } finally {
            setProcessing(null);
        }
    };

    const handleReject = async (id: string) => {
        setProcessing(id);
        try {
            await api.post(`${ENDPOINTS.APPROVALS}/${id}/reject`, { reviewNote: rejectNote || 'Rejeitado' });
            toast('Solicitação bloqueada via política corporativa.', 'success');
            setShowRejectModal(null);
            setRejectNote('');
            if (tab === 'pending') {
                setApprovals((prev: Approval[]) => prev.filter((a: Approval) => a.id !== id));
            } else {
                fetchApprovals();
            }
        } catch (err: unknown) {
            const axiosError = err as { response?: { data?: { error?: string } } };
            toast(axiosError.response?.data?.error || 'Erro ao rejeitar a transação', 'error');
        } finally {
            setProcessing(null);
        }
    };

    const pendingCount = tab === 'pending' ? approvals.length : 0;

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">
                <PageHeader
                    title="Aprovações HITL"
                    subtitle="Fila de aprovação humana"
                    icon={<ShieldAlert className="w-5 h-5" />}
                />

                {/* Tabs */}
                <div role="tablist" className="flex gap-2 p-1.5 bg-card border border-border rounded-xl w-fit shadow-sm">
                    {(['pending', 'approved', 'rejected'] as const).map(t => (
                        <button
                            key={t}
                            role="tab"
                            aria-selected={tab === t}
                            onClick={() => setTab(t)}
                            className={`px-5 py-2.5 rounded-lg text-sm font-bold transition-all duration-300 relative z-10 flex items-center gap-2 ${tab === t
                                ? 'bg-background shadow-md text-foreground ring-1 ring-border/50'
                                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                                }`}
                        >
                            {t === 'pending' && <Clock className={`w-4 h-4 ${tab === t ? 'text-warning-fg' : ''}`} />}
                            {t === 'approved' && <CheckCircle className={`w-4 h-4 ${tab === t ? 'text-emerald-500' : ''}`} />}
                            {t === 'rejected' && <XCircle className={`w-4 h-4 ${tab === t ? 'text-destructive' : ''}`} />}
                            {t === 'pending' ? 'Fila Pendente' : t === 'approved' ? 'Aprovados' : 'Rejeitados (Blocks)'}

                            {t === 'pending' && pendingCount > 0 && (
                                <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-rose-500 text-white font-semibold">
                                    {pendingCount}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* Alerts (Legacy - removing to use Toasts) */}

                {/* Loading */}
                {loading && (
                    <div className="space-y-4">
                        {[1,2,3].map(i => (
                            <div key={i} className="bg-card border border-border rounded-xl p-6 space-y-3">
                                <div className="animate-pulse bg-secondary rounded h-5 w-1/3" />
                                <div className="animate-pulse bg-secondary rounded h-4 w-full" />
                                <div className="animate-pulse bg-secondary rounded h-4 w-2/3" />
                            </div>
                        ))}
                    </div>
                )}

                {/* Empty state */}
                {!loading && approvals.length === 0 && (
                    <div className="text-center py-16 bg-card border border-border rounded-xl">
                        <ShieldAlert className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                        <h3 className="text-base font-semibold mb-1 text-foreground">Quarentena Vazia</h3>
                        <p className="text-muted-foreground max-w-md mx-auto">
                            {tab === 'pending'
                                ? 'Nenhuma transação interceptada aguardando revisão. O fluxo corporativo está limpo.'
                                : 'Nenhuma decisão anterior encontrada neste histórico.'}
                        </p>
                    </div>
                )}

                {/* Approval Cards */}
                {!loading && approvals.length > 0 && (
                    <div className="space-y-4">
                        {approvals.map((a: Approval) => (
                            <div key={a.id} className="bg-card border border-border rounded-xl p-5 space-y-5 border-l-4 hover:border-primary/30 transition-colors"
                                style={{
                                    borderLeftColor: a.status === 'approved' ? '#10b981' : a.status === 'rejected' ? 'hsl(var(--destructive))' : '#f59e0b'
                                }}
                            >
                                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                                    <div className="space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant={approvalBadge(a.status)}>
                                                {a.status === 'pending' && <Clock className="w-3 h-3 mr-0.5" />}
                                                {a.status === 'approved' && <CheckCircle className="w-3 h-3 mr-0.5" />}
                                                {a.status === 'rejected' && <XCircle className="w-3 h-3 mr-0.5" />}
                                                {a.status.toUpperCase()}
                                            </Badge>
                                            {a.risk_level && (
                                                <Badge variant={riskBadge(a.risk_level)}>
                                                    {a.risk_level.toUpperCase()} RISK
                                                </Badge>
                                            )}
                                            <span className="text-sm font-bold flex items-center gap-2">
                                                <Database className="w-4 h-4 text-indigo-400" />
                                                {a.assistant_name || 'Agente Genérico'}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono bg-background/50 inline-flex px-3 py-1.5 rounded border border-border/50">
                                            <span title={a.id}>ID: <span className="text-foreground/70">{a.id.substring(0, 8)}...</span></span>
                                            <span className="text-border/40">|</span>
                                            <span title={a.trace_id}>Trace: <span className="text-foreground/70">{a.trace_id?.substring(0, 8)}...</span></span>
                                        </div>
                                    </div>
                                    <span className="text-xs font-mono text-muted-foreground bg-secondary/30 px-3 py-1.5 rounded-md border border-border/30 h-fit">
                                        {format(new Date(a.created_at), "dd/MM/yyyy • HH:mm:ss", { locale: ptBR })}
                                    </span>
                                </div>

                                <div className="grid md:grid-cols-2 gap-4">
                                    {/* Risk Reason */}
                                    <div className="p-4 bg-rose-500/5 border border-rose-500/10 rounded-xl">
                                        <div className="flex items-center gap-2 text-danger-fg text-xs font-semibold uppercase tracking-wider mb-2">
                                            <AlertTriangle className="w-3.5 h-3.5" /> Motivo da Interceptação (OPA)
                                        </div>
                                        <p className="text-sm font-medium leading-relaxed">{a.justification || a.policy_reason}</p>
                                    </div>

                                    {/* Message */}
                                    <div className="p-4 bg-secondary/30 border border-border/50 rounded-xl">
                                        <div className="flex items-center gap-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-2">
                                            <MessageSquare className="w-3.5 h-3.5" /> Prompt Original
                                        </div>
                                        <p className="text-sm font-mono text-foreground/80 break-words whitespace-pre-wrap leading-relaxed">{a.message}</p>
                                    </div>
                                </div>

                                {/* Reviewer info (for non-pending) */}
                                {a.status !== 'pending' && (
                                    <div className="bg-secondary/30 border border-border/50 rounded-xl p-5 flex flex-col md:flex-row gap-6 relative z-10 text-sm">
                                        <div className="flex items-center gap-3">
                                            <UserCircle className="w-8 h-8 text-muted-foreground" />
                                            <div>
                                                <p className="text-xs text-muted-foreground uppercase font-semibold">Auditor (Human)</p>
                                                <p className="font-bold">{a.reviewer_email}</p>
                                            </div>
                                        </div>
                                        <div className="hidden md:block w-px bg-border/50" />
                                        <div className="flex-1 space-y-1">
                                            <div className="flex justify-between items-start">
                                                <p className="text-xs text-muted-foreground uppercase font-semibold">Decisão Documentada</p>
                                                <span className="text-xs font-mono text-muted-foreground">{a.reviewed_at && format(new Date(a.reviewed_at), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}</span>
                                            </div>
                                            <p className="font-medium italic text-foreground/80">
                                                {a.review_note ? `"${a.review_note}"` : "Sem notas adicionais."}
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {/* Action Buttons (only for pending) */}
                                {a.status === 'pending' && (
                                    <div className="flex flex-col sm:flex-row items-center gap-4 pt-6 mt-4 border-t border-border/50 relative z-10">
                                        {showRejectModal !== a.id ? (
                                            <>
                                                <button
                                                    onClick={() => handleApprove(a.id)}
                                                    disabled={processing === a.id}
                                                    className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-black rounded-xl text-sm font-bold transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50 disabled:shadow-none"
                                                >
                                                    {processing === a.id
                                                        ? <Loader2 className="w-5 h-5 animate-spin" />
                                                        : <CheckCircle className="w-5 h-5" />}
                                                    Aprovar Execução Seguro
                                                </button>
                                                <button
                                                    onClick={() => { setShowRejectModal(a.id); setRejectNote(''); }}
                                                    disabled={processing === a.id}
                                                    className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-transparent border-2 border-destructive/50 hover:bg-destructive hover:border-destructive text-destructive hover:text-foreground rounded-xl text-sm font-bold transition-all"
                                                >
                                                    <XCircle className="w-5 h-5" /> Iniciar Rejeição
                                                </button>
                                            </>
                                        ) : (
                                            /* Reject Modal (inline) */
                                            <div className="w-full p-6 bg-destructive/10 border border-destructive/30 rounded-xl space-y-4 animate-in fade-in slide-in-from-bottom-2">
                                                <p className="text-sm font-bold text-destructive flex items-center gap-2 uppercase tracking-wide">
                                                    <AlertTriangle className="w-4 h-4" /> Documentar Rejeição OPA
                                                </p>
                                                <textarea
                                                    value={rejectNote}
                                                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectNote(e.target.value)}
                                                    placeholder="Especifique a violação para registro de auditoria..."
                                                    className="w-full bg-background border border-border rounded-lg px-4 py-3 text-sm resize-none h-24 focus:outline-none focus:ring-2 focus:ring-destructive shadow-inner"
                                                />
                                                <div className="flex flex-col sm:flex-row gap-3">
                                                    <button
                                                        onClick={() => handleReject(a.id)}
                                                        disabled={processing === a.id}
                                                        className="flex-1 px-6 py-3 bg-destructive hover:bg-red-600 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-destructive/20 flex items-center justify-center gap-2 disabled:opacity-50"
                                                    >
                                                        {processing === a.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                                                        Confirmar Bloqueio
                                                    </button>
                                                    <button
                                                        onClick={() => setShowRejectModal(null)}
                                                        className="px-6 py-3 bg-secondary hover:bg-secondary/80 rounded-lg text-sm font-semibold transition-colors"
                                                    >
                                                        Cancelar
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
