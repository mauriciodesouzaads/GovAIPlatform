'use client';

import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '@/lib/api';
import { Clock, CheckCircle, XCircle, AlertTriangle, Loader2, ShieldAlert, CheckCircle2, UserCircle, MessageSquare, Database } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

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
}

export default function ApprovalsPage() {
    const [approvals, setApprovals] = useState<Approval[]>([]);
    const [loading, setLoading] = useState(true);
    const [processing, setProcessing] = useState<string | null>(null);
    const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
    const [rejectNote, setRejectNote] = useState('');
    const [showRejectModal, setShowRejectModal] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const fetchApprovals = useCallback(async () => {
        setLoading(true);
        try {
            const res = await axios.get(`${API_BASE}/v1/admin/approvals`, { params: { status: tab } });
            setApprovals(res.data);
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao buscar aprovações');
        } finally {
            setLoading(false);
        }
    }, [tab]);

    useEffect(() => { fetchApprovals(); }, [fetchApprovals]);

    const handleApprove = async (id: string) => {
        setProcessing(id);
        setError('');
        setSuccess('');
        try {
            const res = await axios.post(`${API_BASE}/v1/admin/approvals/${id}/approve`);
            setSuccess(`Aprovado e executado com sucesso! Trace do Gateway: ${res.data._govai?.traceId}`);
            fetchApprovals();
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao aprovar a transação');
        } finally {
            setProcessing(null);
            setTimeout(() => setSuccess(''), 5000);
        }
    };

    const handleReject = async (id: string) => {
        setProcessing(id);
        setError('');
        setSuccess('');
        try {
            await axios.post(`${API_BASE}/v1/admin/approvals/${id}/reject`, { note: rejectNote || undefined });
            setSuccess('Solicitação rejeitada com sucesso. O Gateway retornou um bloqueio OPA para o cliente.');
            setShowRejectModal(null);
            setRejectNote('');
            fetchApprovals();
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao rejeitar a transação');
        } finally {
            setProcessing(null);
            setTimeout(() => setSuccess(''), 5000);
        }
    };

    const pendingCount = tab === 'pending' ? approvals.length : 0;

    return (
        <main className="flex-1 overflow-auto p-8 bg-[url('/grid.svg')] bg-cover bg-center bg-no-repeat relative">
            <div className="absolute inset-0 bg-background/90 backdrop-blur-3xl z-0" />
            <div className="max-w-4xl mx-auto space-y-8 relative z-10">
                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-black tracking-tight flex items-center gap-3 bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-amber-600">
                            <ShieldAlert className="w-8 h-8 text-amber-500" />
                            Quarentena HITL
                        </h1>
                        <p className="text-muted-foreground mt-2 font-medium">
                            Human-in-the-Loop — Revisão manual obrigatória de ações de alto risco antes da execução pela IA, regidas pelas políticas do OPA.
                        </p>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-2 p-1.5 glass rounded-xl w-fit shadow-sm relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-white/5 to-transparent pointer-events-none" />
                    {(['pending', 'approved', 'rejected'] as const).map(t => (
                        <button
                            key={t}
                            onClick={() => setTab(t)}
                            className={`px-5 py-2.5 rounded-lg text-sm font-bold transition-all duration-300 relative z-10 flex items-center gap-2 ${tab === t
                                ? 'bg-background shadow-md text-foreground ring-1 ring-border/50'
                                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                                }`}
                        >
                            {t === 'pending' && <Clock className={`w-4 h-4 ${tab === t ? 'text-amber-500' : ''}`} />}
                            {t === 'approved' && <CheckCircle className={`w-4 h-4 ${tab === t ? 'text-emerald-500' : ''}`} />}
                            {t === 'rejected' && <XCircle className={`w-4 h-4 ${tab === t ? 'text-destructive' : ''}`} />}
                            {t === 'pending' ? 'Fila Pendente' : t === 'approved' ? 'Aprovados' : 'Rejeitados (Blocks)'}

                            {t === 'pending' && pendingCount > 0 && (
                                <span className={`ml-1.5 px-2 py-0.5 rounded-full text-[10px] bg-amber-500 text-black animate-pulse`}>
                                    {pendingCount}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* Alerts */}
                {error && (
                    <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-xl text-destructive text-sm font-semibold flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                        <AlertTriangle className="w-5 h-5" /> {error}
                    </div>
                )}
                {success && (
                    <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-500 text-sm font-semibold flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                        <CheckCircle2 className="w-5 h-5" /> {success}
                    </div>
                )}

                {/* Loading */}
                {loading && (
                    <div className="flex flex-col items-center justify-center py-24 space-y-4">
                        <Loader2 className="w-10 h-10 animate-spin text-amber-500" />
                        <p className="text-muted-foreground font-medium animate-pulse">Sincronizando fila de quarentena OPA...</p>
                    </div>
                )}

                {/* Empty state */}
                {!loading && approvals.length === 0 && (
                    <div className="text-center py-24 glass rounded-2xl border-dashed border-2 border-border/50">
                        <ShieldAlert className="w-16 h-16 mx-auto mb-4 text-muted-foreground/30" />
                        <h3 className="text-xl font-bold mb-2 text-foreground/80">Quarentena Vazia</h3>
                        <p className="text-muted-foreground max-w-md mx-auto">
                            {tab === 'pending'
                                ? 'Nenhuma transação interceptada aguardando revisão. O fluxo corporativo está limpo.'
                                : 'Nenhuma decisão anterior encontrada neste histórico.'}
                        </p>
                    </div>
                )}

                {/* Approval Cards */}
                {!loading && approvals.length > 0 && (
                    <div className="space-y-6">
                        {approvals.map(a => (
                            <div key={a.id} className="glass rounded-2xl p-6 md:p-8 space-y-6 border-l-4 hover:border-l-8 transition-all duration-300 relative overflow-hidden group"
                                style={{
                                    borderLeftColor: a.status === 'pending' ? '#f59e0b' : a.status === 'approved' ? '#10b981' : '#ef4444'
                                }}
                            >
                                {/* Decorative background glow */}
                                <div className={`absolute top-0 right-0 w-64 h-64 rounded-full blur-3xl -mr-32 -mt-32 opacity-20 pointer-events-none transition-opacity duration-500 ${a.status === 'pending' ? 'bg-amber-500 group-hover:opacity-40' : a.status === 'approved' ? 'bg-emerald-500' : 'bg-destructive'
                                    }`} />

                                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 relative z-10">
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-3">
                                            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${a.status === 'pending'
                                                ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                                                : a.status === 'approved'
                                                    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                                                    : 'bg-destructive/10 text-destructive border-destructive/30'
                                                }`}>
                                                {a.status === 'pending' && <Clock className="w-3.5 h-3.5" />}
                                                {a.status === 'approved' && <CheckCircle className="w-3.5 h-3.5" />}
                                                {a.status === 'rejected' && <XCircle className="w-3.5 h-3.5" />}
                                                {a.status.toUpperCase()}
                                            </span>
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

                                <div className="grid md:grid-cols-2 gap-6 relative z-10 p-1">
                                    {/* Risk Reason */}
                                    <div className="p-5 bg-amber-500/5 border border-amber-500/20 rounded-xl shadow-inner">
                                        <div className="flex items-center gap-2 text-amber-500 text-xs font-bold uppercase tracking-widest mb-3">
                                            <AlertTriangle className="w-4 h-4" /> Motivo da Interceptação (OPA)
                                        </div>
                                        <p className="text-sm font-medium leading-relaxed">{a.policy_reason}</p>
                                    </div>

                                    {/* Message */}
                                    <div className="p-5 bg-background border border-border/50 rounded-xl shadow-inner">
                                        <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold uppercase tracking-widest mb-3">
                                            <MessageSquare className="w-4 h-4" /> Prompt Original (Input do Usuário)
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
                                                    className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-transparent border-2 border-destructive/50 hover:bg-destructive hover:border-destructive text-destructive hover:text-white rounded-xl text-sm font-bold transition-all"
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
                                                    onChange={e => setRejectNote(e.target.value)}
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
        </main>
    );
}
