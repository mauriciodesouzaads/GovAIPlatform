'use client';

import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '@/lib/api';
import { FileDown, ShieldCheck, AlertTriangle, Activity, Bot, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface ReportData {
    organization: { id: string; name: string };
    period: { start: string; end: string };
    generatedAt: string;
    assistants: Array<{ id: string; name: string; status: string; created_at: string }>;
    summary: {
        totalExecutions: number;
        totalViolations: number;
        totalErrors: number;
        complianceRate: string;
    };
    violationsByType: Array<{ reason: string; count: number }>;
    executions: Array<{
        id: string;
        action: string;
        created_at: string;
        signature: string;
        signatureValid: boolean;
    }>;
}

export default function ReportsPage() {
    const [loading, setLoading] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [data, setData] = useState<ReportData | null>(null);
    const [error, setError] = useState('');

    // Default: last 30 days
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [startDate, setStartDate] = useState(thirtyDaysAgo.toISOString().split('T')[0]);
    const [endDate, setEndDate] = useState(today.toISOString().split('T')[0]);

    const fetchReport = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await axios.get(`${API_BASE}/v1/admin/reports/compliance`, {
                params: { startDate, endDate },
            });
            setData(res.data);
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao gerar relatório');
        } finally {
            setLoading(false);
        }
    }, [startDate, endDate]);

    useEffect(() => { fetchReport(); }, [fetchReport]);

    const downloadPDF = async () => {
        setDownloading(true);
        try {
            const res = await axios.get(`${API_BASE}/v1/admin/reports/compliance`, {
                params: { startDate, endDate, format: 'pdf' },
                responseType: 'blob',
            });
            const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `compliance-report-${startDate}-${endDate}.pdf`;
            link.click();
            window.URL.revokeObjectURL(url);
        } catch (err: any) {
            setError('Erro ao baixar PDF');
        } finally {
            setDownloading(false);
        }
    };

    const complianceRate = parseFloat(data?.summary?.complianceRate || '0');
    const badgeColor = complianceRate >= 95 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
        : complianceRate >= 80 ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
            : 'text-red-400 bg-red-500/10 border-red-500/20';

    return (
        <main className="flex-1 overflow-auto p-8 space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Compliance Reports</h1>
                    <p className="text-muted-foreground text-sm mt-1">BCB 4.557 / LGPD — Relatórios de conformidade regulatória</p>
                </div>
                <button
                    onClick={downloadPDF}
                    disabled={downloading || loading || !data}
                    className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                    {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                    {downloading ? 'Gerando...' : 'Baixar PDF'}
                </button>
            </div>

            {/* Date Range Selector */}
            <div className="flex items-center gap-4 p-4 bg-card border border-border rounded-xl">
                <label className="text-sm text-muted-foreground">Período:</label>
                <input
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="bg-secondary border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-muted-foreground">até</span>
                <input
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="bg-secondary border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                    onClick={fetchReport}
                    disabled={loading}
                    className="px-4 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded-md text-sm font-medium transition-colors"
                >
                    {loading ? 'Carregando...' : 'Atualizar'}
                </button>
            </div>

            {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                    {error}
                </div>
            )}

            {loading && (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
            )}

            {data && !loading && (
                <>
                    {/* Summary Cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                        <div className={`p-5 rounded-xl border ${badgeColor} text-center`}>
                            <div className="text-3xl font-bold">{data.summary.complianceRate}%</div>
                            <div className="text-xs mt-1 opacity-70">Taxa de Compliance</div>
                        </div>
                        <SummaryCard icon={Activity} label="Execuções" value={data.summary.totalExecutions} color="text-blue-400" />
                        <SummaryCard icon={AlertTriangle} label="Violações" value={data.summary.totalViolations} color="text-red-400" />
                        <SummaryCard icon={Bot} label="Assistentes" value={data.assistants.length} color="text-emerald-400" />
                        <SummaryCard icon={ShieldCheck} label="Assinaturas Válidas" value={data.executions.filter(e => e.signatureValid).length} color="text-purple-400" />
                    </div>

                    {/* Agent Inventory */}
                    <section>
                        <h2 className="text-lg font-semibold mb-3">Inventário de Agentes de IA</h2>
                        <div className="bg-card border border-border rounded-xl overflow-hidden">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-secondary/50">
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nome</th>
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">ID</th>
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Criado em</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.assistants.length === 0 && (
                                        <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">Nenhum assistente encontrado.</td></tr>
                                    )}
                                    {data.assistants.map(a => (
                                        <tr key={a.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                                            <td className="px-4 py-3 font-medium">{a.name}</td>
                                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{a.id.substring(0, 18)}...</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${a.status === 'published' ? 'bg-emerald-500/10 text-emerald-400' :
                                                        a.status === 'draft' ? 'bg-amber-500/10 text-amber-400' :
                                                            'bg-secondary text-muted-foreground'
                                                    }`}>
                                                    {a.status.toUpperCase()}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {format(new Date(a.created_at), "dd/MM/yyyy", { locale: ptBR })}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    {/* OPA Violations */}
                    <section>
                        <h2 className="text-lg font-semibold mb-3">Violações Interceptadas (OPA Engine)</h2>
                        {data.violationsByType.length === 0 ? (
                            <div className="p-6 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm flex items-center gap-2">
                                <CheckCircle className="w-4 h-4" /> Nenhuma violação registrada no período.
                            </div>
                        ) : (
                            <div className="bg-card border border-border rounded-xl overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-border bg-secondary/50">
                                            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Tipo de Violação</th>
                                            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Ocorrências</th>
                                            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Distribuição</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.violationsByType.map((v, i) => {
                                            const maxCount = Math.max(...data.violationsByType.map(x => x.count));
                                            const pct = (v.count / maxCount) * 100;
                                            return (
                                                <tr key={i} className="border-b border-border/50">
                                                    <td className="px-4 py-3">{v.reason}</td>
                                                    <td className="px-4 py-3 font-mono font-bold text-red-400">{v.count}</td>
                                                    <td className="px-4 py-3">
                                                        <div className="w-full bg-secondary rounded-full h-2">
                                                            <div className="bg-red-500 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    {/* Execution Log with Signature Verification */}
                    <section>
                        <h2 className="text-lg font-semibold mb-3">Log de Execuções — Verificação Criptográfica</h2>
                        <p className="text-xs text-muted-foreground mb-3">
                            Cada registro contém uma assinatura HMAC-SHA256. O status "Válida" confirma integridade do registro.
                        </p>
                        <div className="bg-card border border-border rounded-xl overflow-hidden">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-secondary/50">
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Data/Hora</th>
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Ação</th>
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Assinatura</th>
                                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Verificação</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.executions.length === 0 && (
                                        <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">Nenhuma execução no período.</td></tr>
                                    )}
                                    {data.executions.slice(0, 50).map(log => (
                                        <tr key={log.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                                            <td className="px-4 py-2.5 text-muted-foreground text-xs">
                                                {format(new Date(log.created_at), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}
                                            </td>
                                            <td className="px-4 py-2.5">
                                                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${log.action === 'EXECUTION_SUCCESS' ? 'bg-emerald-500/10 text-emerald-400' :
                                                        log.action === 'POLICY_VIOLATION' ? 'bg-red-500/10 text-red-400' :
                                                            'bg-amber-500/10 text-amber-400'
                                                    }`}>
                                                    {log.action.replace('_', ' ')}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                                                {log.signature?.substring(0, 20)}...
                                            </td>
                                            <td className="px-4 py-2.5">
                                                {log.signatureValid ? (
                                                    <span className="flex items-center gap-1 text-emerald-400 text-xs font-medium">
                                                        <CheckCircle className="w-3.5 h-3.5" /> Válida
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1 text-red-400 text-xs font-medium">
                                                        <XCircle className="w-3.5 h-3.5" /> Inválida
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {data.executions.length > 50 && (
                                <div className="px-4 py-3 text-xs text-muted-foreground border-t border-border bg-secondary/30">
                                    Exibindo 50 de {data.executions.length} registros. Baixe o PDF para o relatório completo.
                                </div>
                            )}
                        </div>
                    </section>
                </>
            )}
        </main>
    );
}

function SummaryCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
    return (
        <div className="p-5 bg-card border border-border rounded-xl">
            <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 ${color}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
            </div>
            <div className="text-2xl font-bold">{value}</div>
        </div>
    );
}
