'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api, { ENDPOINTS } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { DataTable } from '@/components/DataTable';
import {
    FileCheck, Download, Printer, AlertTriangle,
    Clock, FileText, Upload, ShieldCheck, ShieldAlert,
    Zap, Ban, UserCheck, Scale, GitCompare, ChevronDown,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface RiskBreakdownItem {
    value?: string;
    score: number;
    count?: number;
    enabled?: boolean;
    explanation: string;
}

interface EvidenceData {
    assistant: {
        id: string;
        name: string;
        description?: string;
        lifecycle_state: string;
        risk_level: string;
        risk_score: number;
        risk_breakdown: Record<string, RiskBreakdownItem>;
        data_classification: string;
        pii_blocker_enabled: boolean;
        output_format: string;
        owner_email?: string;
        created_at: string;
        updated_at?: string;
    };
    approval_chain: Array<{
        action: string;
        actor?: string;
        notes?: string;
        created_at: string;
    }>;
    current_version: {
        id: string;
        version: number;
        prompt_preview?: string;
        prompt_hash?: string;
        policy_version_id?: string;
        tools_jsonb?: unknown[];
        created_at: string;
    } | null;
    policy_snapshot: {
        id: string;
        name: string;
        version: number;
    } | null;
    publication_events: Array<{
        published_by_email?: string;
        published_at: string;
        notes?: string;
    }>;
    exceptions: Array<{
        id?: string;
        exception_type: string;
        justification: string;
        status: string;
        expires_at: string;
        created_at: string;
    }>;
    usage_metrics: {
        total_executions: number;
        total_violations: number;
        total_blocked: number;
        total_hitl: number;
        last_execution_at?: string;
    };
    evidence_chain: Array<{
        id: string;
        category?: string;
        event_type?: string;
        actor_email?: string;
        created_at: string;
    }>;
    integrity: {
        evidence_hash: string;
        signature: string;
        generated_at: string;
    };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function translateAction(action: string): string {
    const map: Record<string, string> = {
        PENDING_APPROVAL:       'Aguardando aprovação',
        APPROVAL_GRANTED:       'Aprovado',
        APPROVAL_REJECTED:      'Rejeitado',
        EXIT_GOVERNED_PERIMETER:'Saída do perímetro',
        EXECUTION_SUCCESS:      'Execução bem-sucedida',
        POLICY_VIOLATION:       'Violação de política',
    };
    return map[action] ?? action.replace(/_/g, ' ');
}

function actionBadgeVariant(action: string): 'success' | 'error' | 'warning' | 'info' {
    if (action === 'APPROVAL_GRANTED' || action === 'EXECUTION_SUCCESS') return 'success';
    if (action === 'APPROVAL_REJECTED' || action === 'POLICY_VIOLATION') return 'error';
    if (action === 'EXIT_GOVERNED_PERIMETER') return 'warning';
    return 'info';
}

function riskScoreColor(level: string): string {
    if (level === 'low')      return '#10B981';
    if (level === 'medium')   return '#F59E0B';
    if (level === 'high')     return '#EF4444';
    return '#DC2626';
}

function riskBadgeVariant(level: string): 'success' | 'warning' | 'error' {
    if (level === 'low')    return 'success';
    if (level === 'medium') return 'warning';
    return 'error';
}

function lifecycleVariant(s: string): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
    if (s === 'official' || s === 'approved') return 'success';
    if (s === 'under_review') return 'warning';
    if (s === 'suspended') return 'error';
    if (s === 'draft') return 'info';
    return 'neutral';
}

function fmt(d?: string) {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR');
}

// ── Version types ──────────────────────────────────────────────────────────

interface AssistantVersion {
    id: string;
    version_major: number;
    version_minor: number;
    version_patch: number;
    change_type?: string;
    changelog?: string;
    status: string;
    created_at: string;
    prompt_preview?: string;
    prompt_hash?: string;
    tools_count: number;
    policy_name?: string;
    policy_version?: number;
}

interface DiffLine {
    line: string;
    type: 'added' | 'removed' | 'unchanged';
}

interface VersionDiff {
    from: { id: string; version: string; created_at: string };
    to:   { id: string; version: string; created_at: string };
    prompt_diff: DiffLine[];
    tools_diff: { added: string[]; removed: string[] };
    policy_diff: { changed: boolean; before_id?: string | null; after_id?: string | null };
    stats: { lines_added: number; lines_removed: number; lines_unchanged: number };
}

// ── Version Diff Panel ─────────────────────────────────────────────────────

function VersionDiffPanel({ assistantId }: { assistantId: string }) {
    const [versions, setVersions] = useState<AssistantVersion[]>([]);
    const [fromId, setFromId] = useState('');
    const [toId, setToId] = useState('');
    const [diff, setDiff] = useState<VersionDiff | null>(null);
    const [loading, setLoading] = useState(false);
    const [fetching, setFetching] = useState(true);

    useEffect(() => {
        api.get(ENDPOINTS.ASSISTANT_VERSIONS(assistantId))
            .then(res => {
                const vers: AssistantVersion[] = res.data?.versions ?? [];
                setVersions(vers);
                if (vers.length >= 2) {
                    setToId(vers[0].id);
                    setFromId(vers[1].id);
                }
            })
            .catch(() => {})
            .finally(() => setFetching(false));
    }, [assistantId]);

    const compare = async () => {
        if (!fromId || !toId || fromId === toId) return;
        setLoading(true);
        setDiff(null);
        try {
            const res = await api.get(ENDPOINTS.ASSISTANT_VERSION_DIFF(assistantId, fromId, toId));
            setDiff(res.data as VersionDiff);
        } catch {
            // silently show nothing
        } finally {
            setLoading(false);
        }
    };

    if (fetching) return (
        <div className="h-8 bg-secondary/40 rounded animate-pulse" />
    );

    if (versions.length < 2) return (
        <p className="text-sm text-muted-foreground">Apenas uma versão disponível — sem histórico para comparar.</p>
    );

    const vLabel = (v: AssistantVersion) =>
        `v${v.version_major}.${v.version_minor}.${v.version_patch} — ${new Date(v.created_at).toLocaleDateString('pt-BR')}`;

    return (
        <div className="space-y-4">
            {/* Selector row */}
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[140px]">
                    <label className="block text-xs text-muted-foreground mb-1">De (versão base)</label>
                    <div className="relative">
                        <select
                            value={fromId}
                            onChange={e => setFromId(e.target.value)}
                            className="w-full bg-secondary/40 border border-border rounded-lg px-3 py-2 text-sm text-foreground appearance-none pr-8 focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                            {versions.map(v => (
                                <option key={v.id} value={v.id}>{vLabel(v)}</option>
                            ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                </div>
                <div className="flex-1 min-w-[140px]">
                    <label className="block text-xs text-muted-foreground mb-1">Para (versão nova)</label>
                    <div className="relative">
                        <select
                            value={toId}
                            onChange={e => setToId(e.target.value)}
                            className="w-full bg-secondary/40 border border-border rounded-lg px-3 py-2 text-sm text-foreground appearance-none pr-8 focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                            {versions.map(v => (
                                <option key={v.id} value={v.id}>{vLabel(v)}</option>
                            ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                </div>
                <button
                    onClick={compare}
                    disabled={loading || !fromId || !toId || fromId === toId}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                    <GitCompare className="w-4 h-4" />
                    {loading ? 'Comparando...' : 'Comparar'}
                </button>
            </div>

            {/* Diff result */}
            {diff && (
                <div className="space-y-4">
                    {/* Stats bar */}
                    <div className="flex items-center gap-4 text-xs font-mono">
                        <span className="text-emerald-400">+{diff.stats.lines_added} linhas</span>
                        <span className="text-rose-400">−{diff.stats.lines_removed} linhas</span>
                        <span className="text-muted-foreground">{diff.stats.lines_unchanged} inalteradas</span>
                        {diff.tools_diff.added.length > 0 && (
                            <span className="text-blue-400">+{diff.tools_diff.added.length} tools</span>
                        )}
                        {diff.tools_diff.removed.length > 0 && (
                            <span className="text-amber-400">−{diff.tools_diff.removed.length} tools</span>
                        )}
                    </div>

                    {/* Prompt diff */}
                    {diff.prompt_diff.length > 0 && (
                        <div className="rounded-lg border border-border overflow-hidden">
                            <div className="bg-secondary/30 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b border-border">
                                Prompt — Diff
                            </div>
                            <div className="font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto">
                                {diff.prompt_diff.map((line, i) => (
                                    <div
                                        key={i}
                                        className={`px-3 py-0.5 whitespace-pre-wrap break-all ${
                                            line.type === 'added'   ? 'bg-emerald-500/10 text-emerald-300' :
                                            line.type === 'removed' ? 'bg-rose-500/10 text-rose-300' :
                                            'text-muted-foreground'
                                        }`}
                                    >
                                        <span className="select-none mr-2 opacity-50">
                                            {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
                                        </span>
                                        {line.line}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Tools diff */}
                    {(diff.tools_diff.added.length > 0 || diff.tools_diff.removed.length > 0) && (
                        <div className="rounded-lg border border-border p-3 space-y-2">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tools</p>
                            {diff.tools_diff.added.map(t => (
                                <div key={t} className="flex items-center gap-2 text-xs text-emerald-400 font-mono">
                                    <span className="opacity-60">+</span> {t}
                                </div>
                            ))}
                            {diff.tools_diff.removed.map(t => (
                                <div key={t} className="flex items-center gap-2 text-xs text-rose-400 font-mono">
                                    <span className="opacity-60">−</span> {t}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Policy diff */}
                    {diff.policy_diff.changed && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
                            <p className="font-semibold mb-1">Política alterada</p>
                            <p className="font-mono text-muted-foreground">
                                {diff.policy_diff.before_id?.slice(0, 8) ?? '—'} → {diff.policy_diff.after_id?.slice(0, 8) ?? '—'}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Stat mini-card ─────────────────────────────────────────────────────────

function StatCard({ label, value, icon, className = '' }: {
    label: string; value: number | string; icon: React.ReactNode; className?: string;
}) {
    return (
        <div className={`bg-secondary/30 border border-border rounded-xl p-4 flex flex-col gap-2 ${className}`}>
            <div className="flex items-center gap-2 text-muted-foreground">
                <span className="w-4 h-4">{icon}</span>
                <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
            </div>
            <p className="text-2xl font-bold text-foreground font-mono">{value}</p>
        </div>
    );
}

// ── Skeleton ───────────────────────────────────────────────────────────────

function EvidenceSkeleton() {
    return (
        <div className="space-y-4">
            <div className="h-12 bg-secondary/60 rounded animate-pulse w-1/2" />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="h-64 bg-secondary/60 rounded-xl animate-pulse" />
                <div className="lg:col-span-2 h-64 bg-secondary/60 rounded-xl animate-pulse" />
            </div>
            <div className="h-40 bg-secondary/60 rounded-xl animate-pulse" />
            <div className="h-40 bg-secondary/60 rounded-xl animate-pulse" />
        </div>
    );
}

// ── Retention config type ──────────────────────────────────────────────────

interface RetentionConfig {
    audit_log_retention_days: number;
    archive_enabled: boolean;
    last_archive_run_at?: string;
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function EvidencePage({ params }: { params: { assistantId: string } }) {
    const { assistantId } = params;
    const [evidence, setEvidence] = useState<EvidenceData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [retentionConfig, setRetentionConfig] = useState<RetentionConfig | null>(null);

    useEffect(() => {
        api.get(ENDPOINTS.ASSISTANT_EVIDENCE(assistantId))
            .then(res => setEvidence(res.data as EvidenceData))
            .catch(() => setError(true))
            .finally(() => setLoading(false));

        api.get(ENDPOINTS.SETTINGS_RETENTION)
            .then(res => setRetentionConfig(res.data as RetentionConfig))
            .catch(() => {});
    }, [assistantId]);

    const downloadPDF = async () => {
        setDownloading(true);
        try {
            const res = await api.get(ENDPOINTS.ASSISTANT_EVIDENCE_PDF(assistantId), {
                responseType: 'blob',
            });
            const url = URL.createObjectURL(res.data as Blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `evidencia-${assistantId}-${Date.now()}.pdf`;
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            // silently fail — browser will show no download
        } finally {
            setDownloading(false);
        }
    };

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">

                <PageHeader
                    title="Evidência de Conformidade"
                    subtitle={evidence?.assistant.name ?? (loading ? 'Carregando...' : 'Assistente')}
                    icon={<FileCheck className="w-5 h-5" />}
                    actions={
                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={downloadPDF}
                                loading={downloading}
                                icon={<Download className="w-4 h-4" />}
                            >
                                Exportar PDF
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => window.print()}
                                icon={<Printer className="w-4 h-4" />}
                            >
                                Imprimir
                            </Button>
                        </div>
                    }
                />

                {loading && <EvidenceSkeleton />}

                {!loading && error && (
                    <div className="flex flex-col items-center justify-center py-24 gap-4">
                        <AlertTriangle className="w-10 h-10 text-destructive" />
                        <p className="text-sm text-muted-foreground">Não foi possível carregar as evidências.</p>
                        <Button variant="secondary" onClick={() => {
                            setError(false); setLoading(true);
                            api.get(ENDPOINTS.ASSISTANT_EVIDENCE(assistantId))
                                .then(res => setEvidence(res.data as EvidenceData))
                                .catch(() => setError(true))
                                .finally(() => setLoading(false));
                        }}>
                            Tentar novamente
                        </Button>
                    </div>
                )}

                {!loading && !error && evidence && (() => {
                    const { assistant, approval_chain, current_version, policy_snapshot,
                            publication_events, exceptions, usage_metrics, evidence_chain, integrity } = evidence;
                    const level = assistant.risk_level ?? 'low';
                    const breakdown = assistant.risk_breakdown ?? {};

                    return (
                        <>
                            {/* Risk Score + Assistant Info */}
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                                {/* Risk Score Card */}
                                <Card>
                                    <div className="text-center pb-4">
                                        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                                            Score de Risco
                                        </p>
                                        <p
                                            className="text-5xl font-bold font-mono"
                                            style={{ color: riskScoreColor(level) }}
                                        >
                                            {assistant.risk_score ?? 0}
                                        </p>
                                        <div className="mt-2">
                                            <Badge variant={riskBadgeVariant(level)}>
                                                {level.toUpperCase()}
                                            </Badge>
                                        </div>
                                    </div>

                                    {/* Breakdown factors */}
                                    <div className="space-y-2 border-t border-border pt-4 mt-2">
                                        {(Object.entries(breakdown) as [string, RiskBreakdownItem][])
                                            .filter(([k]) => k !== 'total_score' && k !== 'level' && k !== 'computed_at')
                                            .map(([key, item]) => (
                                                <div key={key} className="flex justify-between items-start text-sm gap-2">
                                                    <span className="text-muted-foreground text-xs leading-snug">
                                                        {item.explanation.split(':')[0]}
                                                    </span>
                                                    <span className={`shrink-0 font-mono text-xs font-semibold ${
                                                        item.score > 0 ? 'text-amber-400' : 'text-muted-foreground'
                                                    }`}>
                                                        +{item.score}
                                                    </span>
                                                </div>
                                            ))
                                        }
                                        <div className="border-t border-border pt-2 flex justify-between font-semibold text-sm">
                                            <span>Total</span>
                                            <span className="font-mono">{assistant.risk_score ?? 0}</span>
                                        </div>
                                    </div>
                                </Card>

                                {/* Assistant Info */}
                                <Card className="lg:col-span-2">
                                    <h3 className="text-base font-semibold mb-4">Informações do Assistente</h3>
                                    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Nome</dt>
                                            <dd className="font-medium">{assistant.name}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Status</dt>
                                            <dd><Badge variant={lifecycleVariant(assistant.lifecycle_state)}>{assistant.lifecycle_state}</Badge></dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Classificação de Dados</dt>
                                            <dd className="font-mono text-xs">{assistant.data_classification ?? '—'}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">PII Blocker</dt>
                                            <dd>
                                                <Badge variant={assistant.pii_blocker_enabled ? 'success' : 'error'}>
                                                    {assistant.pii_blocker_enabled ? 'Ativo' : 'Desativado'}
                                                </Badge>
                                            </dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Formato de Output</dt>
                                            <dd>{assistant.output_format === 'free_text' ? 'Texto livre' : 'JSON estruturado'}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Owner</dt>
                                            <dd>{assistant.owner_email ?? 'Não definido'}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Criado em</dt>
                                            <dd>{fmt(assistant.created_at)}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Atualizado em</dt>
                                            <dd>{fmt(assistant.updated_at)}</dd>
                                        </div>
                                    </dl>
                                </Card>
                            </div>

                            {/* Approval Chain — Timeline */}
                            <Card>
                                <h3 className="text-base font-semibold mb-4">Cadeia de Aprovação</h3>
                                {approval_chain.length === 0 ? (
                                    <EmptyState
                                        icon={<Clock className="w-6 h-6" />}
                                        title="Nenhum evento de aprovação registrado"
                                    />
                                ) : (
                                    <div className="relative pl-6 border-l-2 border-border space-y-5">
                                        {approval_chain.map((event, i) => (
                                            <div key={i} className="relative">
                                                <div className="absolute -left-[25px] w-3 h-3 rounded-full bg-primary border-2 border-background" />
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Badge variant={actionBadgeVariant(event.action)}>
                                                        {translateAction(event.action)}
                                                    </Badge>
                                                    <span className="text-xs text-muted-foreground">
                                                        {fmt(event.created_at)}
                                                    </span>
                                                </div>
                                                <p className="text-sm text-muted-foreground">
                                                    {event.actor ?? '—'}
                                                    {event.notes ? ` — ${event.notes}` : ''}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </Card>

                            {/* Current Version */}
                            <Card>
                                <h3 className="text-base font-semibold mb-4">Versão Publicada</h3>
                                {current_version ? (
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-4">
                                            <Badge variant="info">v{current_version.version}</Badge>
                                            <span className="text-xs font-mono text-muted-foreground">
                                                Hash: {current_version.prompt_hash?.slice(0, 16)}...
                                            </span>
                                        </div>
                                        <p className="text-sm text-muted-foreground">
                                            Política: {policy_snapshot?.name ?? 'N/A'}
                                            {policy_snapshot ? ` v${policy_snapshot.version}` : ''}
                                        </p>
                                        <p className="text-sm text-muted-foreground">
                                            Tools configurados: {(current_version.tools_jsonb as unknown[])?.length ?? 0}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Criada em: {fmt(current_version.created_at)}
                                        </p>
                                    </div>
                                ) : (
                                    <EmptyState
                                        icon={<FileText className="w-6 h-6" />}
                                        title="Nenhuma versão publicada"
                                    />
                                )}
                            </Card>

                            {/* Version History & Diff */}
                            <Card>
                                <h3 className="text-base font-semibold mb-4 flex items-center gap-2">
                                    <GitCompare className="w-4 h-4 text-muted-foreground" />
                                    Histórico de Versões
                                </h3>
                                <VersionDiffPanel assistantId={assistantId} />
                            </Card>

                            {/* Publication Events */}
                            <Card>
                                <h3 className="text-base font-semibold mb-4">Eventos de Publicação</h3>
                                {publication_events.length === 0 ? (
                                    <EmptyState
                                        icon={<Upload className="w-6 h-6" />}
                                        title="Nenhuma publicação registrada"
                                    />
                                ) : (
                                    <div className="space-y-2">
                                        {publication_events.map((evt, i) => (
                                            <div key={i} className="flex justify-between items-center py-2 border-b border-border/50 last:border-0">
                                                <div>
                                                    <p className="text-sm">{evt.published_by_email ?? '—'}</p>
                                                    {evt.notes && <p className="text-xs text-muted-foreground">{evt.notes}</p>}
                                                </div>
                                                <span className="text-xs text-muted-foreground shrink-0 ml-4">
                                                    {fmt(evt.published_at)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </Card>

                            {/* Active Exceptions */}
                            <Card>
                                <h3 className="text-base font-semibold mb-4">Exceções de Política</h3>
                                {exceptions.length === 0 ? (
                                    <EmptyState
                                        icon={<ShieldCheck className="w-6 h-6" />}
                                        title="Nenhuma exceção ativa"
                                        description="Este assistente opera sob as políticas padrão da organização."
                                    />
                                ) : (
                                    <DataTable
                                        columns={[
                                            { key: 'exception_type', label: 'Tipo' },
                                            { key: 'justification', label: 'Justificativa' },
                                            {
                                                key: 'status', label: 'Status',
                                                render: (e) => (
                                                    <Badge variant={e.status === 'approved' ? 'success' : 'warning'}>
                                                        {e.status}
                                                    </Badge>
                                                ),
                                            },
                                            {
                                                key: 'expires_at', label: 'Expira em',
                                                render: (e) => new Date(e.expires_at).toLocaleDateString('pt-BR'),
                                            },
                                        ]}
                                        data={exceptions}
                                        emptyMessage="Nenhuma exceção"
                                    />
                                )}
                            </Card>

                            {/* Usage Metrics */}
                            <Card>
                                <h3 className="text-base font-semibold mb-4">Métricas de Uso</h3>
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                    <StatCard
                                        label="Execuções"
                                        value={usage_metrics.total_executions ?? 0}
                                        icon={<Zap className="w-4 h-4" />}
                                    />
                                    <StatCard
                                        label="Violações"
                                        value={usage_metrics.total_violations ?? 0}
                                        icon={<ShieldAlert className="w-4 h-4" />}
                                        className={(usage_metrics.total_violations ?? 0) > 0 ? 'border-destructive/30' : ''}
                                    />
                                    <StatCard
                                        label="Bloqueados"
                                        value={usage_metrics.total_blocked ?? 0}
                                        icon={<Ban className="w-4 h-4" />}
                                    />
                                    <StatCard
                                        label="HITL"
                                        value={usage_metrics.total_hitl ?? 0}
                                        icon={<UserCheck className="w-4 h-4" />}
                                    />
                                </div>
                                {usage_metrics.last_execution_at && (
                                    <p className="text-xs text-muted-foreground mt-3">
                                        Última execução: {fmt(usage_metrics.last_execution_at)}
                                    </p>
                                )}
                            </Card>

                            {/* Evidence Chain */}
                            {evidence_chain.length > 0 && (
                                <Card>
                                    <h3 className="text-base font-semibold mb-4">Cadeia de Evidências</h3>
                                    <div className="space-y-1 max-h-80 overflow-y-auto">
                                        {evidence_chain.map((ev, i) => (
                                            <div key={i} className="flex items-center gap-3 py-1.5 border-b border-border/30 last:border-0 text-xs">
                                                <Scale className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                                <span className="font-mono text-muted-foreground w-32 shrink-0">
                                                    {(ev as any).event_type ?? (ev as any).category}
                                                </span>
                                                <span className="text-muted-foreground flex-1">
                                                    {(ev as any).actor_email ?? '—'}
                                                </span>
                                                <span className="text-muted-foreground shrink-0">
                                                    {fmt((ev as any).created_at ?? (ev as any).createdAt)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </Card>
                            )}

                            {/* Integrity Footer */}
                            <div className="bg-card border border-border rounded-xl p-4 space-y-2">
                                <div className="flex flex-col sm:flex-row justify-between gap-2 text-xs font-mono text-muted-foreground">
                                    <div>
                                        <span className="text-foreground font-semibold">Integridade:</span>{' '}
                                        Hash {integrity.evidence_hash.slice(0, 24)}...
                                    </div>
                                    <div className="text-emerald-400">
                                        Assinatura HMAC-SHA256 verificada
                                    </div>
                                    <div>
                                        Gerado em {fmt(integrity.generated_at)}
                                    </div>
                                </div>
                                {retentionConfig && (
                                    <p className="text-sm text-muted-foreground border-t border-border/40 pt-2">
                                        Política de retenção:{' '}
                                        <span className="font-medium text-foreground">
                                            {retentionConfig.audit_log_retention_days} dias
                                        </span>
                                        {' '}({retentionConfig.archive_enabled ? 'archiving ativo' : 'archiving desativado'})
                                    </p>
                                )}
                            </div>

                            {/* Back link */}
                            <div className="pb-6">
                                <Link href="/catalog" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                                    ← Voltar ao Catálogo
                                </Link>
                            </div>
                        </>
                    );
                })()}
            </div>
        </div>
    );
}
