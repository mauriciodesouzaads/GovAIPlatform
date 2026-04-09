'use client';

import { useState } from 'react';
import api, { ENDPOINTS } from '@/lib/api';
import {
    FileDown, FileText, Shield, AlertTriangle, Activity, Bot,
    Loader2, CheckCircle, XCircle, RefreshCw, Hash, TrendingUp, Eye,
} from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ExecutiveSummary {
    totalAssistants: number;
    activeAssistants: number;
    postureScore: number;
    complianceRate: string;
    totalExecutions: number;
    totalViolations: number;
    pendingApprovals: number;
}

interface AssistantEntry {
    id: string; name: string; status: string;
    lifecycle_state: string; risk_level: string;
    data_classification: string; created_at: string;
}

interface PostureSnapshot {
    generated_at: string; summary_score: number;
    open_findings: number; unresolved_critical: number;
}

interface AuditLogEntry {
    id: string; action: string; created_at: string;
    signature: string; signatureValid: boolean;
    metadata: Record<string, unknown>;
}

interface AuditReportData {
    organization: { id: string; name: string };
    period: { from: string; to: string };
    generatedAt: string;
    sections: {
        executiveSummary: ExecutiveSummary;
        assistantInventory: AssistantEntry[];
        postureHistory: PostureSnapshot[];
        shadowAI: { total: number; bySeverity: Record<string, number>; byStatus: Record<string, number> };
        executionMetrics: { byAction: Record<string, number>; period: { from: string; to: string } };
        auditTrail: AuditLogEntry[];
    };
    integrity: { hash: string; algorithm: string };
}

// ── Action badge styles ────────────────────────────────────────────────────────

function actionBadge(action: string) {
    if (action === 'EXECUTION_SUCCESS')   return 'bg-emerald-500/10 text-emerald-400';
    if (action === 'POLICY_VIOLATION')    return 'bg-red-500/10 text-red-400';
    if (action === 'PENDING_APPROVAL')    return 'bg-amber-500/10 text-amber-400';
    if (action === 'APPROVAL_GRANTED')    return 'bg-blue-500/10 text-blue-400';
    if (action === 'QUOTA_EXCEEDED')      return 'bg-orange-500/10 text-orange-400';
    return 'bg-secondary text-muted-foreground';
}

function riskBadge(level: string) {
    if (level === 'critical') return 'bg-red-500/10 text-red-400';
    if (level === 'high')     return 'bg-orange-500/10 text-orange-400';
    if (level === 'medium')   return 'bg-amber-500/10 text-amber-400';
    return 'bg-emerald-500/10 text-emerald-400';
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
    const [loading, setLoading]       = useState(false);
    const [downloading, setDownloading] = useState<'pdf' | 'json' | null>(null);
    const [data, setData]             = useState<AuditReportData | null>(null);
    const [error, setError]           = useState('');

    const today          = new Date();
    const ninetyDaysAgo  = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    const [startDate, setStartDate] = useState(ninetyDaysAgo.toISOString().split('T')[0]);
    const [endDate,   setEndDate]   = useState(today.toISOString().split('T')[0]);

    const generateReport = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await api.get(ENDPOINTS.REPORTS_COMPLIANCE_AUDIT, {
                params: { from: startDate, to: endDate },
            });
            setData(res.data);
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: string } } };
            setError(e.response?.data?.error || 'Erro ao gerar relatório');
        } finally {
            setLoading(false);
        }
    };

    const downloadPDF = async () => {
        setDownloading('pdf');
        try {
            const res = await api.get(ENDPOINTS.REPORTS_COMPLIANCE_AUDIT, {
                params: { from: startDate, to: endDate, format: 'pdf' },
                responseType: 'blob',
            });
            const url  = window.URL.createObjectURL(res.data);
            const link = document.createElement('a');
            link.href  = url;
            link.download = `audit-report-${startDate}-${endDate}.pdf`;
            link.click();
            window.URL.revokeObjectURL(url);
        } catch {
            setError('Erro ao baixar PDF');
        } finally {
            setDownloading(null);
        }
    };

    const downloadJSON = () => {
        if (!data) return;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href  = url;
        link.download = `audit-report-${startDate}-${endDate}.json`;
        link.click();
        window.URL.revokeObjectURL(url);
    };

    const complianceRate = parseFloat(data?.sections.executiveSummary.complianceRate || '0');
    const rateColor = complianceRate >= 95
        ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
        : complianceRate >= 80
        ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
        : 'text-red-400 bg-red-500/10 border-red-500/20';

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">

                <PageHeader
                    title="Relatório de Auditoria de Conformidade"
                    subtitle="BCB 4.557 / LGPD — 7 seções com hash de integridade SHA-256"
                    icon={<FileText className="w-5 h-5" />}
                    actions={
                        <div className="flex items-center gap-2">
                            <button
                                onClick={downloadJSON}
                                disabled={!data || !!downloading}
                                className="flex items-center gap-2 px-3 py-2 bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
                            >
                                <FileDown className="w-4 h-4" />
                                JSON
                            </button>
                            <button
                                onClick={downloadPDF}
                                disabled={!data || !!downloading}
                                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40"
                            >
                                {downloading === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                                {downloading === 'pdf' ? 'Gerando PDF...' : 'Baixar PDF'}
                            </button>
                        </div>
                    }
                />

                {/* Period picker + Generate button */}
                <div className="flex flex-wrap items-center gap-3 p-4 bg-card border border-border rounded-xl">
                    <label className="text-sm text-muted-foreground">Período:</label>
                    <input
                        type="date"
                        value={startDate}
                        onChange={e => setStartDate(e.target.value)}
                        className="bg-secondary border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="text-muted-foreground text-sm">até</span>
                    <input
                        type="date"
                        value={endDate}
                        onChange={e => setEndDate(e.target.value)}
                        className="bg-secondary border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                        onClick={generateReport}
                        disabled={loading}
                        className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                    >
                        {loading
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Gerando...</>
                            : <><RefreshCw className="w-4 h-4" /> Gerar Relatório</>}
                    </button>
                </div>

                {error && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">{error}</div>
                )}

                {/* Empty state */}
                {!data && !loading && !error && (
                    <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground gap-3">
                        <Eye className="w-12 h-12 opacity-30" />
                        <p className="text-base font-medium">Nenhum relatório gerado</p>
                        <p className="text-sm">Selecione o período e clique em &ldquo;Gerar Relatório&rdquo;</p>
                    </div>
                )}

                {/* Preview */}
                {data && !loading && (
                    <div className="space-y-6">

                        {/* Section 1: Executive Summary */}
                        <Section title="1. Sumário Executivo" icon={<Activity className="w-4 h-4 text-blue-400" />}>
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 mb-4">
                                <KpiCard label="Taxa Compliance" value={`${data.sections.executiveSummary.complianceRate}%`} className={rateColor} />
                                <KpiCard label="Postura IA" value={`${data.sections.executiveSummary.postureScore}/100`} color="text-blue-400" />
                                <KpiCard label="Assistentes" value={data.sections.executiveSummary.totalAssistants} color="text-emerald-400" />
                                <KpiCard label="Ativos" value={data.sections.executiveSummary.activeAssistants} color="text-emerald-400" />
                                <KpiCard label="Execuções" value={data.sections.executiveSummary.totalExecutions} color="text-blue-400" />
                                <KpiCard label="Violações" value={data.sections.executiveSummary.totalViolations} color="text-red-400" />
                                <KpiCard label="HITL Pendentes" value={data.sections.executiveSummary.pendingApprovals} color="text-amber-400" />
                            </div>
                            <p className="text-sm text-muted-foreground">
                                Período analisado: <strong>{data.period.from}</strong> a <strong>{data.period.to}</strong>.
                                Gerado em: {format(new Date(data.generatedAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}.
                                Organização: {data.organization.name}.
                            </p>
                        </Section>

                        {/* Section 2: Assistant Inventory */}
                        <Section title="2. Inventário de Assistentes" icon={<Bot className="w-4 h-4 text-emerald-400" />}>
                            {data.sections.assistantInventory.length === 0 ? (
                                <p className="text-sm text-muted-foreground py-4">Nenhum assistente no inventário (oficial / aprovado / em revisão).</p>
                            ) : (
                                <div className="overflow-x-auto rounded-lg border border-border">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-border bg-secondary/50">
                                                <Th>Nome</Th><Th>Status</Th><Th>Ciclo de Vida</Th><Th>Risco</Th><Th>Classificação</Th><Th>Criado em</Th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {data.sections.assistantInventory.map(a => (
                                                <tr key={a.id} className="border-b border-border/50 hover:bg-secondary/30">
                                                    <td className="px-4 py-2.5 font-medium">{a.name}</td>
                                                    <td className="px-4 py-2.5">
                                                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.status === 'published' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
                                                            {a.status?.toUpperCase()}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-2.5 text-muted-foreground capitalize">{(a.lifecycle_state || '—').replace(/_/g, ' ')}</td>
                                                    <td className="px-4 py-2.5">
                                                        {a.risk_level && (
                                                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskBadge(a.risk_level)}`}>
                                                                {a.risk_level.toUpperCase()}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-2.5 text-muted-foreground text-xs">{a.data_classification || '—'}</td>
                                                    <td className="px-4 py-2.5 text-muted-foreground text-xs">{format(new Date(a.created_at), 'dd/MM/yyyy', { locale: ptBR })}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Section>

                        {/* Section 3: Posture History */}
                        <Section title="3. Histórico de Postura de Risco" icon={<TrendingUp className="w-4 h-4 text-blue-400" />}>
                            {data.sections.postureHistory.length === 0 ? (
                                <p className="text-sm text-muted-foreground py-4">Nenhum snapshot de postura disponível.</p>
                            ) : (
                                <div className="overflow-x-auto rounded-lg border border-border">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-border bg-secondary/50">
                                                <Th>Data do Snapshot</Th><Th>Score</Th><Th>Findings Abertos</Th><Th>Críticos</Th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {data.sections.postureHistory.map((p, i) => (
                                                <tr key={i} className="border-b border-border/50 hover:bg-secondary/30">
                                                    <td className="px-4 py-2.5 text-muted-foreground">{format(new Date(p.generated_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</td>
                                                    <td className="px-4 py-2.5">
                                                        <span className={`font-bold ${p.summary_score >= 70 ? 'text-emerald-400' : p.summary_score >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                                                            {p.summary_score}/100
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-2.5 font-mono">{p.open_findings}</td>
                                                    <td className="px-4 py-2.5 font-mono text-red-400">{p.unresolved_critical}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Section>

                        {/* Section 4: Shadow AI */}
                        <Section title={`4. Shadow AI — Findings (Total: ${data.sections.shadowAI.total})`} icon={<Shield className="w-4 h-4 text-orange-400" />}>
                            {data.sections.shadowAI.total === 0 ? (
                                <div className="flex items-center gap-2 text-emerald-400 text-sm py-2">
                                    <CheckCircle className="w-4 h-4" /> Nenhum finding de Shadow AI registrado.
                                </div>
                            ) : (
                                <div className="grid sm:grid-cols-2 gap-4">
                                    <div>
                                        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Por Severidade</p>
                                        <div className="space-y-1.5">
                                            {Object.entries(data.sections.shadowAI.bySeverity).sort((a, b) => b[1] - a[1]).map(([sev, cnt]) => (
                                                <div key={sev} className="flex items-center justify-between text-sm">
                                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskBadge(sev)}`}>{sev.toUpperCase()}</span>
                                                    <span className="font-mono font-bold">{cnt}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Por Status</p>
                                        <div className="space-y-1.5">
                                            {Object.entries(data.sections.shadowAI.byStatus).sort((a, b) => b[1] - a[1]).map(([status, cnt]) => (
                                                <div key={status} className="flex items-center justify-between text-sm">
                                                    <span className="text-muted-foreground capitalize">{status.replace(/_/g, ' ')}</span>
                                                    <span className="font-mono font-bold">{cnt}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </Section>

                        {/* Section 5: Execution Metrics */}
                        <Section title="5. Métricas de Execução" icon={<Activity className="w-4 h-4 text-purple-400" />}>
                            {Object.keys(data.sections.executionMetrics.byAction).length === 0 ? (
                                <p className="text-sm text-muted-foreground py-4">Nenhum evento registrado no período.</p>
                            ) : (
                                <div className="overflow-x-auto rounded-lg border border-border">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-border bg-secondary/50">
                                                <Th>Ação</Th><Th>Ocorrências</Th><Th>% do Total</Th><Th>Distribuição</Th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(() => {
                                                const entries = Object.entries(data.sections.executionMetrics.byAction).sort((a, b) => b[1] - a[1]);
                                                const total = entries.reduce((s, [, v]) => s + v, 0);
                                                return entries.map(([action, cnt]) => {
                                                    const pct = total > 0 ? ((cnt / total) * 100).toFixed(1) : '0';
                                                    return (
                                                        <tr key={action} className="border-b border-border/50 hover:bg-secondary/30">
                                                            <td className="px-4 py-2.5">
                                                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${actionBadge(action)}`}>
                                                                    {action.replace(/_/g, ' ')}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-2.5 font-mono font-bold">{cnt}</td>
                                                            <td className="px-4 py-2.5 text-muted-foreground">{pct}%</td>
                                                            <td className="px-4 py-2.5 w-40">
                                                                <div className="w-full bg-secondary rounded-full h-1.5">
                                                                    <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    );
                                                });
                                            })()}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Section>

                        {/* Section 6: Audit Trail */}
                        <Section title={`6. Trilha de Auditoria — Últimas ${data.sections.auditTrail.length} Entradas`} icon={<Shield className="w-4 h-4 text-blue-400" />}>
                            <p className="text-xs text-muted-foreground mb-3">
                                Cada registro contém assinatura HMAC-SHA256. &ldquo;Válida&rdquo; confirma integridade criptográfica.
                            </p>
                            <div className="overflow-x-auto rounded-lg border border-border">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-border bg-secondary/50">
                                            <Th>Data/Hora</Th><Th>Ação</Th><Th>Assinatura</Th><Th>Verificação</Th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.sections.auditTrail.length === 0 && (
                                            <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">Nenhuma entrada no período.</td></tr>
                                        )}
                                        {data.sections.auditTrail.map(log => (
                                            <tr key={log.id} className="border-b border-border/50 hover:bg-secondary/30">
                                                <td className="px-4 py-2 text-muted-foreground text-xs">
                                                    {format(new Date(log.created_at), 'dd/MM/yyyy HH:mm:ss', { locale: ptBR })}
                                                </td>
                                                <td className="px-4 py-2">
                                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${actionBadge(log.action)}`}>
                                                        {log.action.replace(/_/g, ' ')}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                                                    {log.signature?.substring(0, 16)}...
                                                </td>
                                                <td className="px-4 py-2">
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
                            </div>
                        </Section>

                        {/* Section 7: Integrity Hash */}
                        <Section title="7. Hash de Integridade do Relatório" icon={<Hash className="w-4 h-4 text-purple-400" />}>
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <span className="px-2 py-1 bg-purple-500/10 text-purple-400 rounded font-mono font-medium">
                                        {data.integrity.algorithm}
                                    </span>
                                    <span>Hash computado sobre o conteúdo completo do relatório</span>
                                </div>
                                <div className="p-3 bg-secondary/50 rounded-lg border border-border">
                                    <p className="font-mono text-xs break-all text-muted-foreground">{data.integrity.hash}</p>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Qualquer alteração no conteúdo deste relatório invalidará este hash e poderá ser detectada em auditoria posterior.
                                </p>
                            </div>
                        </Section>

                    </div>
                )}
            </div>
        </div>
    );
}

// ── Helper components ──────────────────────────────────────────────────────────

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <section className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
                {icon}
                <h2 className="text-base font-semibold">{title}</h2>
            </div>
            {children}
        </section>
    );
}

function Th({ children }: { children: React.ReactNode }) {
    return <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{children}</th>;
}

function KpiCard({ label, value, color, className }: { label: string; value: string | number; color?: string; className?: string }) {
    return (
        <div className={`p-4 rounded-xl border text-center ${className ?? 'bg-card border-border'}`}>
            <div className={`text-xl font-bold ${color ?? ''}`}>{value}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
        </div>
    );
}
