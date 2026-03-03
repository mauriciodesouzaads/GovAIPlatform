'use client';

import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '@/lib/api';
import { Clock, CheckCircle, XCircle, AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';
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
            setSuccess(`Aprovado e executado com sucesso! Trace: ${res.data._govai?.traceId}`);
            fetchApprovals();
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao aprovar');
        } finally {
            setProcessing(null);
        }
    };

    const handleReject = async (id: string) => {
        setProcessing(id);
        setError('');
        setSuccess('');
        try {
            await axios.post(`${API_BASE}/v1/admin/approvals/${id}/reject`, { note: rejectNote || undefined });
            setSuccess('Solicitação rejeitada com sucesso.');
            setShowRejectModal(null);
            setRejectNote('');
            fetchApprovals();
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao rejeitar');
        } finally {
            setProcessing(null);
        }
    };

    const pendingCount = tab === 'pending' ? approvals.length : 0;

    return (
        <main className="flex-1 overflow-auto p-8 space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                    <ShieldAlert className="w-6 h-6 text-amber-400" />
                    Aprovações Pendentes
                </h1>
                <p className="text-muted-foreground text-sm mt-1">
                    Human-in-the-Loop — Revisão de ações de alto risco antes da execução da IA
                </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 p-1 bg-secondary/50 rounded-lg w-fit">
                {(['pending', 'approved', 'rejected'] as const).map(t => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                            }`}
                    >
                        {t === 'pending' && <Clock className="w-3.5 h-3.5 inline mr-1.5" />}
                        {t === 'approved' && <CheckCircle className="w-3.5 h-3.5 inline mr-1.5" />}
                        {t === 'rejected' && <XCircle className="w-3.5 h-3.5 inline mr-1.5" />}
                        {t === 'pending' ? 'Pendentes' : t === 'approved' ? 'Aprovados' : 'Rejeitados'}
                    </button>
                ))}
            </div>

            {/* Alerts */}
            {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                    {error}
                </div>
            )}
            {success && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-sm">
                    {success}
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
            )}

            {/* Empty state */}
            {!loading && approvals.length === 0 && (
                <div className="text-center py-16 text-muted-foreground">
                    <ShieldAlert className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p className="text-lg font-medium">Nenhuma solicitação {tab === 'pending' ? 'pendente' : tab === 'approved' ? 'aprovada' : 'rejeitada'}</p>
                    <p className="text-sm mt-1">
                        {tab === 'pending'
                            ? 'Quando ações de alto risco forem detectadas, elas aparecerão aqui para revisão.'
                            : 'Nenhuma decisão encontrada nesta categoria.'}
                    </p>
                </div>
            )}

            {/* Approval Cards */}
            {!loading && approvals.length > 0 && (
                <div className="space-y-4">
                    {approvals.map(a => (
                        <div key={a.id} className="bg-card border border-border rounded-xl p-5 space-y-4">
                            <div className="flex items-start justify-between">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${a.status === 'pending'
                                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                                : a.status === 'approved'
                                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                                            }`}>
                                            {a.status === 'pending' && <Clock className="w-3 h-3" />}
                                            {a.status === 'approved' && <CheckCircle className="w-3 h-3" />}
                                            {a.status === 'rejected' && <XCircle className="w-3 h-3" />}
                                            {a.status.toUpperCase()}
                                        </span>
                                        <span className="text-sm font-medium">{a.assistant_name || 'Assistente'}</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground font-mono">
                                        ID: {a.id.substring(0, 12)}... | Trace: {a.trace_id?.substring(0, 12)}...
                                    </p>
                                </div>
                                <span className="text-xs text-muted-foreground">
                                    {format(new Date(a.created_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                                </span>
                            </div>

                            {/* Risk Reason */}
                            <div className="p-3 bg-amber-500/5 border border-amber-500/15 rounded-lg">
                                <div className="flex items-center gap-1.5 text-amber-400 text-xs font-medium mb-1">
                                    <AlertTriangle className="w-3.5 h-3.5" /> Motivo da Retenção
                                </div>
                                <p className="text-sm">{a.policy_reason}</p>
                            </div>

                            {/* Message */}
                            <div className="p-3 bg-secondary/50 rounded-lg">
                                <p className="text-xs text-muted-foreground mb-1 font-medium">Prompt do Usuário:</p>
                                <p className="text-sm font-mono">{a.message}</p>
                            </div>

                            {/* Reviewer info (for non-pending) */}
                            {a.status !== 'pending' && (
                                <div className="text-xs text-muted-foreground space-y-0.5">
                                    <p>Revisado por: <strong>{a.reviewer_email}</strong></p>
                                    <p>Data: {a.reviewed_at && format(new Date(a.reviewed_at), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}</p>
                                    {a.review_note && <p>Observação: {a.review_note}</p>}
                                </div>
                            )}

                            {/* Action Buttons (only for pending) */}
                            {a.status === 'pending' && (
                                <div className="flex items-center gap-3 pt-2 border-t border-border">
                                    <button
                                        onClick={() => handleApprove(a.id)}
                                        disabled={processing === a.id}
                                        className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                                    >
                                        {processing === a.id
                                            ? <Loader2 className="w-4 h-4 animate-spin" />
                                            : <CheckCircle className="w-4 h-4" />}
                                        Aprovar e Executar
                                    </button>
                                    <button
                                        onClick={() => { setShowRejectModal(a.id); setRejectNote(''); }}
                                        disabled={processing === a.id}
                                        className="flex items-center gap-2 px-4 py-2 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 text-red-400 rounded-lg text-sm font-medium transition-colors"
                                    >
                                        <XCircle className="w-4 h-4" /> Rejeitar
                                    </button>
                                </div>
                            )}

                            {/* Reject Modal (inline) */}
                            {showRejectModal === a.id && (
                                <div className="p-4 bg-red-500/5 border border-red-500/20 rounded-lg space-y-3">
                                    <p className="text-sm font-medium text-red-400">Justificativa para rejeição (opcional):</p>
                                    <textarea
                                        value={rejectNote}
                                        onChange={e => setRejectNote(e.target.value)}
                                        placeholder="Motivo da rejeição..."
                                        className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-red-500"
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => handleReject(a.id)}
                                            disabled={processing === a.id}
                                            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
                                        >
                                            {processing === a.id ? 'Rejeitando...' : 'Confirmar Rejeição'}
                                        </button>
                                        <button
                                            onClick={() => setShowRejectModal(null)}
                                            className="px-4 py-2 bg-secondary hover:bg-secondary/80 rounded-lg text-sm font-medium transition-colors"
                                        >
                                            Cancelar
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </main>
    );
}
