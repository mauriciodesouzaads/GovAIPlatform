'use client';

import { useEffect, useState, useCallback } from 'react';
import {
    UserCog, ChevronDown, ChevronRight, AlertTriangle,
    CheckCircle2, Clock, Loader2, Shield, Activity,
    RefreshCw, Eye, MessageSquare,
} from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';

// ── Types ──────────────────────────────────────────────────────────────────

interface ConsultantTenant {
    orgId: string;
    orgName: string;
}

interface ConsultantPosture {
    openFindings: number;
    criticalFindings: number;
    highFindings: number;
    promotedFindings: number;
    acceptedRisk: number;
    overallScore: number;
    generatedAt?: string;
}

interface ConsultantFinding {
    id: string;
    tool_name: string;
    tool_name_normalized: string;
    severity: string;
    status: string;
    risk_score: number;
    observation_count: number;
    unique_users: number;
    last_seen_at: string;
}

interface FindingAction {
    id: string;
    finding_id: string;
    action_type: string;
    actor_id: string;
    note?: string;
    created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function severityColor(s: string) {
    switch (s) {
        case 'critical':     return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        case 'high':         return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
        case 'medium':       return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
        case 'low':          return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
        default:             return 'text-gray-400 bg-gray-400/10 border-gray-400/20';
    }
}

function statusColor(s: string) {
    switch (s) {
        case 'open':         return 'text-amber-400';
        case 'acknowledged': return 'text-blue-400';
        case 'promoted':     return 'text-emerald-500';
        case 'accepted_risk':return 'text-gray-400';
        case 'dismissed':    return 'text-gray-500';
        case 'resolved':     return 'text-emerald-400';
        default:             return 'text-gray-400';
    }
}

function fmtDate(d?: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function actionIcon(actionType: string) {
    switch (actionType) {
        case 'acknowledged':  return '👁';
        case 'promoted':      return '✅';
        case 'accepted_risk': return '⚠️';
        case 'dismissed':     return '🚫';
        case 'resolved':      return '🔒';
        case 'reopened':      return '🔄';
        case 'comment':       return '💬';
        case 'assigned':      return '👤';
        default:              return '•';
    }
}

// ── Posture Cards ──────────────────────────────────────────────────────────

function PostureCard({ label, value, accent }: { label: string; value: number; accent: string }) {
    return (
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
            <p className={`text-2xl font-bold ${accent}`}>{value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{label}</p>
        </div>
    );
}

// ── Action Timeline ────────────────────────────────────────────────────────

function ActionTimeline({ actions, loading }: { actions: FindingAction[]; loading: boolean }) {
    if (loading) return (
        <div className="flex items-center gap-2 text-gray-600 py-4 pl-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="text-xs">Carregando timeline...</span>
        </div>
    );
    if (actions.length === 0) return (
        <p className="text-xs text-gray-600 py-4 pl-2">Nenhuma ação registrada.</p>
    );

    return (
        <div className="space-y-2 pl-2 border-l border-white/10 ml-2">
            {actions.map(a => (
                <div key={a.id} className="relative pl-4">
                    <div className="absolute -left-[9px] top-1 w-3.5 h-3.5 rounded-full bg-[#0f0f0f] border border-white/20 flex items-center justify-center text-[8px]">
                        {actionIcon(a.action_type)}
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium text-gray-300 capitalize">{a.action_type.replace('_', ' ')}</span>
                        <span className="text-[10px] text-gray-600 shrink-0">{fmtDate(a.created_at)}</span>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-0.5">por {a.actor_id}</p>
                    {a.note && <p className="text-[10px] text-gray-400 bg-white/5 rounded px-2 py-1 mt-1 italic">"{a.note}"</p>}
                </div>
            ))}
        </div>
    );
}

// ── Finding Row ────────────────────────────────────────────────────────────

function FindingRow({ finding, tenantOrgId }: { finding: ConsultantFinding; tenantOrgId: string }) {
    const [expanded, setExpanded] = useState(false);
    const [actions, setActions] = useState<FindingAction[]>([]);
    const [loadingActions, setLoadingActions] = useState(false);

    const loadActions = useCallback(async () => {
        if (actions.length > 0) return; // already loaded
        try {
            setLoadingActions(true);
            const res = await api.get(`/v1/consultant/tenants/${tenantOrgId}/shield/findings/${finding.id}/actions`);
            setActions(res.data?.actions ?? []);
        } catch {
            // silently fail — action timeline is informational
        } finally {
            setLoadingActions(false);
        }
    }, [finding.id, tenantOrgId, actions.length]);

    const toggle = () => {
        if (!expanded) loadActions();
        setExpanded(v => !v);
    };

    return (
        <>
            <tr
                className="border-t border-white/5 hover:bg-white/[0.02] cursor-pointer transition-colors"
                onClick={toggle}
            >
                <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-600" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-600" />}
                        <span className="text-sm text-white font-medium">{finding.tool_name_normalized}</span>
                        <span className="text-xs text-gray-600 hidden sm:inline">({finding.tool_name})</span>
                    </div>
                </td>
                <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${severityColor(finding.severity)}`}>
                        {finding.severity}
                    </span>
                </td>
                <td className="py-3 px-4">
                    <span className={`text-xs font-medium capitalize ${statusColor(finding.status)}`}>
                        {finding.status.replace('_', ' ')}
                    </span>
                </td>
                <td className="py-3 px-4 text-xs text-amber-400 font-mono">{finding.risk_score.toFixed(2)}</td>
                <td className="py-3 px-4 text-xs text-gray-500">{finding.observation_count}</td>
                <td className="py-3 px-4 text-xs text-gray-500 hidden md:table-cell">{fmtDate(finding.last_seen_at)}</td>
            </tr>
            {expanded && (
                <tr className="border-t border-white/5 bg-white/[0.01]">
                    <td colSpan={6} className="px-6 py-4">
                        <div className="flex items-center gap-2 mb-3">
                            <MessageSquare className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Timeline de Ações</span>
                        </div>
                        <ActionTimeline actions={actions} loading={loadingActions} />
                    </td>
                </tr>
            )}
        </>
    );
}

// ── Tenant Panel ───────────────────────────────────────────────────────────

function TenantPanel({ tenant }: { tenant: ConsultantTenant }) {
    const [collapsed, setCollapsed] = useState(false);
    const [posture, setPosture] = useState<ConsultantPosture | null>(null);
    const [findings, setFindings] = useState<ConsultantFinding[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const [pRes, fRes] = await Promise.all([
                api.get(`/v1/consultant/tenants/${tenant.orgId}/shield/posture`),
                api.get(`/v1/consultant/tenants/${tenant.orgId}/shield/findings`),
            ]);
            setPosture(pRes.data);
            setFindings(fRes.data?.findings ?? []);
        } catch (e: any) {
            if (e.response?.status === 403) {
                setError('Acesso não autorizado para este tenant. Verifique suas permissões de consultoria.');
            } else {
                setError(e.response?.data?.error ?? e.message);
            }
        } finally {
            setLoading(false);
        }
    }, [tenant.orgId]);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="bg-white/[0.02] border border-white/10 rounded-xl overflow-hidden">
            {/* Tenant header */}
            <button
                onClick={() => setCollapsed(v => !v)}
                className="w-full flex items-center justify-between p-5 hover:bg-white/[0.02] transition-colors"
            >
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                        <Shield className="w-4 h-4 text-amber-400" />
                    </div>
                    <div className="text-left">
                        <p className="text-sm font-semibold text-white">{tenant.orgName}</p>
                        <p className="text-[10px] text-gray-600 font-mono">{tenant.orgId}</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {posture && !loading && (
                        <div className="flex items-center gap-4 text-xs text-gray-500">
                            <span className="text-rose-400 font-semibold">{posture.criticalFindings} crítico{posture.criticalFindings !== 1 ? 's' : ''}</span>
                            <span className="text-amber-400">{posture.openFindings} aberto{posture.openFindings !== 1 ? 's' : ''}</span>
                            <span className="text-gray-600">Score: <span className="text-white">{posture.overallScore.toFixed(0)}</span></span>
                        </div>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); load(); }} className="text-gray-600 hover:text-gray-400 p-1">
                        <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    {collapsed ? <ChevronRight className="w-4 h-4 text-gray-600" /> : <ChevronDown className="w-4 h-4 text-gray-600" />}
                </div>
            </button>

            {!collapsed && (
                <div className="px-5 pb-5 space-y-5 border-t border-white/5">
                    {loading && (
                        <div className="flex items-center gap-2 text-gray-600 py-8 justify-center">
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span className="text-sm">Carregando dados do tenant...</span>
                        </div>
                    )}

                    {error && !loading && (
                        <div className="flex items-center gap-3 p-4 mt-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            {error}
                        </div>
                    )}

                    {posture && !loading && (
                        <>
                            {/* Posture Cards */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                                <PostureCard label="Findings Abertos" value={posture.openFindings} accent="text-amber-400" />
                                <PostureCard label="Críticos" value={posture.criticalFindings} accent="text-rose-400" />
                                <PostureCard label="Promovidos" value={posture.promotedFindings} accent="text-emerald-400" />
                                <PostureCard label="Risco Aceito" value={posture.acceptedRisk} accent="text-gray-400" />
                            </div>

                            {/* Findings Table */}
                            <div>
                                <div className="flex items-center gap-2 mb-3">
                                    <Eye className="w-3.5 h-3.5 text-gray-500" />
                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                        Findings ({findings.length})
                                    </span>
                                </div>
                                {findings.length === 0 ? (
                                    <p className="text-xs text-gray-600 py-4">Nenhum finding encontrado para este tenant.</p>
                                ) : (
                                    <div className="overflow-x-auto rounded-lg border border-white/10">
                                        <table className="w-full text-left">
                                            <thead>
                                                <tr className="bg-white/[0.03]">
                                                    <th className="py-2.5 px-4 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Ferramenta</th>
                                                    <th className="py-2.5 px-4 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Severidade</th>
                                                    <th className="py-2.5 px-4 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Status</th>
                                                    <th className="py-2.5 px-4 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Score</th>
                                                    <th className="py-2.5 px-4 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Obs.</th>
                                                    <th className="py-2.5 px-4 text-[10px] font-semibold text-gray-600 uppercase tracking-wider hidden md:table-cell">Última vez</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {findings.map(f => (
                                                    <FindingRow key={f.id} finding={f} tenantOrgId={tenant.orgId} />
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ConsultantPage() {
    const { role, orgId } = useAuth();
    const { toast } = useToast();
    const [tenants, setTenants] = useState<ConsultantTenant[]>([]);
    const [loading, setLoading] = useState(true);

    // Derive accessible tenants from /v1/admin/organizations.
    // Roles without access to that endpoint get a 403; fall back to the
    // user's own org from AuthProvider context (populated via /v1/admin/me).
    const loadTenants = useCallback(async () => {
        // Wait until AuthProvider has resolved orgId — avoid API calls with empty tenant ID
        if (!orgId) return;

        try {
            setLoading(true);
            const res = await api.get('/v1/admin/organizations');
            const orgs: Array<{ id: string; name: string }> = res.data?.organizations ?? res.data ?? [];
            setTenants(orgs.map(o => ({ orgId: o.id, orgName: o.name })));
        } catch (e: any) {
            if (e.response?.status === 403) {
                // Use orgId from AuthProvider context (resolved from /v1/admin/me)
                setTenants([{ orgId, orgName: orgId }]);
            } else {
                toast(e.response?.data?.error ?? e.message, 'error');
            }
        } finally {
            setLoading(false);
        }
    }, [orgId, toast]);

    useEffect(() => { loadTenants(); }, [loadTenants]);

    return (
        <div className="relative min-h-screen bg-black text-white overflow-hidden">
            <div className="absolute inset-0 bg-[url('/grid.svg')] opacity-[0.03] pointer-events-none" />
            <div className="absolute inset-0 bg-gradient-to-b from-amber-500/5 via-transparent to-transparent pointer-events-none" />

            <div className="relative max-w-[1400px] mx-auto px-6 py-8 space-y-8">

                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                            <UserCog className="w-5 h-5 text-amber-400" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-white tracking-tight">Painel do Consultor</h1>
                            <p className="text-sm text-gray-500">Visão cross-tenant de postura e findings — somente leitura.</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
                        <Activity className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-xs text-amber-400 font-medium capitalize">{role}</span>
                    </div>
                </div>

                {/* Readonly notice */}
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-blue-500/5 border border-blue-500/20 text-blue-400 text-xs">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    Este painel é somente leitura. Ações corretivas devem ser executadas pelos administradores de cada tenant.
                </div>

                {/* Tenants */}
                {loading ? (
                    <div className="flex items-center justify-center py-24 text-gray-600">
                        <Loader2 className="w-8 h-8 animate-spin mr-3" />
                        Carregando tenants...
                    </div>
                ) : tenants.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-24 text-gray-600 gap-3">
                        <UserCog className="w-10 h-10 opacity-30" />
                        <p className="text-sm">Nenhum tenant acessível encontrado.</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {tenants.map(t => (
                            <TenantPanel key={t.orgId} tenant={t} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
