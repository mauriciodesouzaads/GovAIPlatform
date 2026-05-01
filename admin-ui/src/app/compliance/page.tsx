'use client';

import { useEffect, useState, useCallback } from 'react';
import api, { ENDPOINTS, API_BASE } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { ToggleRight, ToggleLeft, ShieldCheck, AlertTriangle, RefreshCw, Eye, EyeOff, Download, Building2 } from 'lucide-react';
import { SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';

// ── Types ────────────────────────────────────────────────────────────────────

interface OrgConsent {
    id: string;
    name: string;
    status: string;
    telemetry_consent: boolean;
    telemetry_consent_at: string | null;
    telemetry_pii_strip: boolean;
    consented_by_email?: string | null;
}

interface UpdateState {
    [orgId: string]: 'idle' | 'loading' | 'error';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CompliancePage() {
    const [orgs, setOrgs] = useState<OrgConsent[]>([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState(false);
    const [updateState, setUpdateState] = useState<UpdateState>({});
    const { toast } = useToast();
    // GA-014: use role to select the correct endpoint
    const { role } = useAuth();

    const fetchOrgs = useCallback(async () => {
        setLoading(true);
        setFetchError(false);
        try {
            if (role === 'dpo') {
                // GA-014: DPO uses the restricted /compliance/dpo-summary endpoint
                const res = await api.get<{ organization: OrgConsent; recentAuditLogs: unknown[] }>(
                    ENDPOINTS.COMPLIANCE_DPO_SUMMARY
                );
                const org = res.data.organization;
                setOrgs(org ? [org] : []);
            } else {
                // admin: full organizations list
                const res = await api.get<OrgConsent[]>(ENDPOINTS.ORGANIZATIONS);
                setOrgs(res.data);
            }
        } catch (err: any) {
            setFetchError(true);
            toast(err?.response?.data?.error ?? 'Erro ao carregar organizações. Verifique sua conexão.', 'error');
        } finally {
            setLoading(false);
        }
    }, [toast, role]);

    useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

    const [exporting, setExporting] = useState(false);

    const exportAuditTrail = useCallback(async () => {
        setExporting(true);
        try {
            const token = typeof window !== 'undefined' ? localStorage.getItem('govai_admin_token') : null;
            const url = `${API_BASE}${ENDPOINTS.COMPLIANCE_AUDIT_TRAIL()}`;
            const response = await fetch(url, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                credentials: 'include',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const blob = await response.blob();
            const disposition = response.headers.get('Content-Disposition') ?? '';
            const match = disposition.match(/filename="([^"]+)"/);
            const filename = match ? match[1] : 'lgpd-audit-trail.csv';
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(objectUrl);
            toast(`Exportação concluída: ${filename}`, 'success');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Tente novamente.';
            toast(`Erro ao exportar: ${msg}`, 'error');
        } finally {
            setExporting(false);
        }
    }, [toast]);

    const updateConsent = async (
        org: OrgConsent,
        field: 'telemetry_consent' | 'telemetry_pii_strip',
        value: boolean
    ) => {
        setUpdateState(s => ({ ...s, [org.id]: 'loading' }));
        try {
            const payload = field === 'telemetry_consent'
                ? { consent: value, pii_strip: org.telemetry_pii_strip }
                : { consent: org.telemetry_consent, pii_strip: value };

            const res = await api.put(ENDPOINTS.ORGANIZATION_TELEMETRY_CONSENT(org.id), payload);

            setOrgs(prev => prev.map(o =>
                o.id === org.id
                    ? {
                        ...o,
                        telemetry_consent: res.data.telemetry_consent,
                        telemetry_pii_strip: res.data.telemetry_pii_strip,
                        telemetry_consent_at: res.data.telemetry_consent_at,
                    }
                    : o
            ));

            setUpdateState(s => ({ ...s, [org.id]: 'idle' }));

            const action = field === 'telemetry_consent'
                ? (value ? 'Consentimento concedido' : 'Consentimento revogado')
                : (value ? 'Modo PII Strip ativado' : 'Modo PII Strip desativado');
            toast(`${action} — ${org.name} — log de auditoria registrado.`, 'success');
        } catch (err: any) {
            setUpdateState(s => ({ ...s, [org.id]: 'error' }));
            toast(err?.response?.data?.error ?? 'Erro ao atualizar consentimento. Tente novamente.', 'error');
        }
    };

    const consentedCount = orgs.filter(o => o.telemetry_consent).length;

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
            <PageHeader
                title="Compliance LGPD"
                subtitle="Consentimento de telemetria"
                icon={<ShieldCheck className="w-5 h-5" />}
                actions={
                    <>
                        <button
                            onClick={exportAuditTrail}
                            disabled={exporting || loading}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-50"
                            title="Exportar trilha de auditoria LGPD (últimos 30 dias)"
                        >
                            <Download className={`w-4 h-4 ${exporting ? 'animate-bounce' : ''}`} />
                            Exportar CSV
                        </button>
                        <button
                            onClick={fetchOrgs}
                            disabled={loading}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-50"
                        >
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                            Atualizar
                        </button>
                    </>
                }
            />

            {/* Summary bar */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {loading ? (
                    <>
                        <div className="rounded-xl border border-border bg-card/60 p-4 space-y-2"><div className="h-3 bg-secondary/60 rounded animate-pulse w-2/3" /><div className="h-7 bg-secondary/60 rounded animate-pulse w-1/2" /></div>
                        <div className="rounded-xl border border-border bg-card/60 p-4 space-y-2"><div className="h-3 bg-secondary/60 rounded animate-pulse w-2/3" /><div className="h-7 bg-secondary/60 rounded animate-pulse w-1/2" /></div>
                        <div className="rounded-xl border border-border bg-card/60 p-4 space-y-2"><div className="h-3 bg-secondary/60 rounded animate-pulse w-2/3" /><div className="h-7 bg-secondary/60 rounded animate-pulse w-1/2" /></div>
                    </>
                ) : (
                    <>
                        <div className="rounded-xl border border-border bg-card/60 p-4">
                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total de Tenants</p>
                            <p className="text-2xl font-bold text-foreground">{orgs.length}</p>
                        </div>
                        <div className="rounded-xl border border-border bg-card/60 p-4">
                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Com Consentimento</p>
                            <p className="text-2xl font-bold text-emerald-500">{consentedCount}</p>
                        </div>
                        <div className="rounded-xl border border-border bg-card/60 p-4">
                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Sem Consentimento</p>
                            <p className="text-2xl font-bold text-warning-fg">{orgs.length - consentedCount}</p>
                        </div>
                    </>
                )}
            </div>

            {/* Warning banner */}
            <div className="flex items-start gap-3 rounded-xl border border-warning-border bg-yellow-500/5 px-4 py-3 text-sm text-warning-fg">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning-fg" />
                <span>
                    <strong>Atenção:</strong> Ao habilitar a telemetria, prompts e completions dos usuários
                    serão enviados ao Langfuse. Use <strong>PII Strip</strong> para enviar apenas métricas
                    agregadas (tokens, latência, custo) sem conteúdo dos prompts.
                    Esta configuração pode ser alterada a qualquer momento.
                </span>
            </div>

            {/* Organizations table */}
            {fetchError && !loading && (
                <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-8 text-center space-y-3">
                    <AlertTriangle className="w-8 h-8 text-destructive mx-auto" />
                    <p className="text-sm font-semibold text-foreground">Erro ao carregar organizações</p>
                    <p className="text-xs text-muted-foreground">Verifique sua conexão e tente novamente.</p>
                    <button
                        onClick={fetchOrgs}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-sm font-medium transition-colors"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Tentar novamente
                    </button>
                </div>
            )}

            {loading ? (
                <SkeletonTable rows={4} cols={5} />
            ) : !fetchError && orgs.length === 0 ? (
                <div className="rounded-xl border border-border bg-card/40 p-12 text-center space-y-3">
                    <Building2 className="w-10 h-10 text-muted-foreground/30 mx-auto" />
                    <p className="text-sm font-semibold text-foreground">Nenhuma organização encontrada</p>
                    <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                        Não há organizações configuradas para gerenciar consentimento de telemetria.
                    </p>
                </div>
            ) : !fetchError ? (
                <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
                    <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border/50 bg-background/40">
                                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Organização</th>
                                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                                <th className="text-center px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    Telemetria
                                </th>
                                <th className="text-center px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    <span className="flex items-center justify-center gap-1">
                                        <EyeOff className="w-3.5 h-3.5" />
                                        PII Strip
                                    </span>
                                </th>
                                <th className="hidden md:table-cell text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Consentido em</th>
                                <th className="hidden lg:table-cell text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Por</th>
                            </tr>
                        </thead>
                        <tbody>
                            {orgs.map((org, idx) => {
                                const isLoading = updateState[org.id] === 'loading';
                                return (
                                    <tr
                                        key={org.id}
                                        className={`border-b border-border/30 transition-colors ${idx % 2 === 0 ? 'bg-transparent' : 'bg-background/20'} hover:bg-secondary/20`}
                                    >
                                        {/* Name */}
                                        <td className="px-4 py-3">
                                            <span className="font-medium text-foreground">{org.name}</span>
                                            <span className="block text-[10px] text-muted-foreground/60 font-mono mt-0.5">{org.id}</span>
                                        </td>

                                        {/* Status */}
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                                                org.status === 'active'
                                                    ? 'bg-success-bg text-success-fg'
                                                    : 'bg-muted/40 text-muted-foreground'
                                            }`}>
                                                {org.status}
                                            </span>
                                        </td>

                                        {/* Telemetry toggle */}
                                        <td className="px-4 py-3 text-center">
                                            <button
                                                onClick={() => updateConsent(org, 'telemetry_consent', !org.telemetry_consent)}
                                                disabled={isLoading}
                                                className={`inline-flex items-center justify-center transition-all ${
                                                    isLoading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:scale-110'
                                                }`}
                                                title={org.telemetry_consent ? 'Revogar consentimento' : 'Conceder consentimento'}
                                                aria-label={`Telemetria: ${org.telemetry_consent ? 'ativa' : 'inativa'} para ${org.name}`}
                                            >
                                                {org.telemetry_consent
                                                    ? <ToggleRight className="w-8 h-8 text-emerald-500" />
                                                    : <ToggleLeft className="w-8 h-8 text-muted-foreground/40" />
                                                }
                                            </button>
                                        </td>

                                        {/* PII Strip toggle */}
                                        <td className="px-4 py-3 text-center">
                                            <button
                                                onClick={() => updateConsent(org, 'telemetry_pii_strip', !org.telemetry_pii_strip)}
                                                disabled={isLoading || !org.telemetry_consent}
                                                className={`inline-flex items-center justify-center transition-all ${
                                                    !org.telemetry_consent
                                                        ? 'opacity-20 cursor-not-allowed'
                                                        : isLoading
                                                            ? 'opacity-40 cursor-not-allowed'
                                                            : 'cursor-pointer hover:scale-110'
                                                }`}
                                                title={
                                                    !org.telemetry_consent
                                                        ? 'Habilite a telemetria primeiro'
                                                        : org.telemetry_pii_strip
                                                            ? 'PII Strip ativo — desativar para enviar prompts completos'
                                                            : 'PII Strip inativo — ativar para enviar apenas métricas'
                                                }
                                                aria-label={`PII Strip: ${org.telemetry_pii_strip ? 'ativo' : 'inativo'} para ${org.name}`}
                                            >
                                                {org.telemetry_pii_strip
                                                    ? <EyeOff className="w-5 h-5 text-info-fg" />
                                                    : <Eye className="w-5 h-5 text-muted-foreground/40" />
                                                }
                                            </button>
                                        </td>

                                        {/* Consent date */}
                                        <td className="hidden md:table-cell px-4 py-3 text-muted-foreground text-xs">
                                            {org.telemetry_consent
                                                ? <span className="text-foreground/80">{formatDate(org.telemetry_consent_at)}</span>
                                                : <span className="text-muted-foreground/40">—</span>
                                            }
                                        </td>

                                        {/* Consented by */}
                                        <td className="hidden lg:table-cell px-4 py-3 text-xs text-muted-foreground">
                                            {org.telemetry_consent && org.consented_by_email
                                                ? <span className="text-foreground/70 font-mono">{org.consented_by_email}</span>
                                                : <span className="text-muted-foreground/40">—</span>
                                            }
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    </div>
                </div>
            ) : null}

            {/* LGPD footer note */}
            <p className="text-xs text-muted-foreground/50 text-center">
                LGPD Art. 7, I — consentimento livre, informado e inequívoco.
                Toda alteração é registrada com assinatura HMAC-SHA256 em{' '}
                <code className="font-mono bg-secondary/30 px-1 rounded">audit_logs_partitioned</code>.
            </p>
            </div>
        </div>
    );
}
