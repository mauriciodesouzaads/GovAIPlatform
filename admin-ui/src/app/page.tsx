'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import {
  Activity, ShieldCheck, Coins, ArrowUpRight, ShieldAlert, CreditCard, Bot, Info,
  Database, Server, Zap, AlertTriangle, LayoutDashboard, Clock, FileWarning,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  RadialBarChart, RadialBar, PolarAngleAxis, PieChart, Pie, Cell, Legend,
} from 'recharts';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';

interface RiskDistItem { risk_level: string; count: string; }
interface ShadowFinding { id: string; assistant_name: string; finding_type: string; severity: string; created_at: string; }
interface PosturePoint { snapshot_date: string; posture_score: number; }

interface DashboardStats {
  total_assistants: number;
  total_executions: number;
  total_violations: number;
  total_tokens?: number;
  estimated_cost_usd?: string;
  usage_history?: { name: string; requests: number; violations: number; }[];
  risk_distribution?: RiskDistItem[];
  top_shadow_ai?: ShadowFinding[];
  posture_history?: PosturePoint[];
  pending_reviews?: number;
  expiring_exceptions?: number;
}

const RISK_COLORS: Record<string, string> = {
  critical: '#f43f5e',
  high: '#fb923c',
  medium: '#fbbf24',
  low: '#34d399',
  undefined: '#6b7280',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
  high: 'bg-orange-500/10 text-orange-400 border border-orange-500/20',
  medium: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  low: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
};

function SummaryCard({
  icon, label, value, sub, color, href, tooltip,
}: {
  icon: React.ReactNode; label: string; value: string | number; sub: string;
  color: string; href?: string; tooltip?: string;
}) {
  return (
    <div className={`bg-card border ${color} rounded-xl p-5 hover:border-primary/30 transition-colors group flex flex-col justify-between`}>
      <div className="flex justify-between items-start">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${color}`}>
          {icon}
        </div>
        {href && (
          <Link href={href} className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-secondary hover:bg-secondary/80 px-2 py-1 rounded text-foreground flex items-center gap-1">
            Ver <ArrowUpRight className="w-3 h-3" />
          </Link>
        )}
      </div>
      <div className="mt-4">
        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1 flex items-center justify-between">
          {label}
          {tooltip && (
            <span title={tooltip}>
              <Info className="w-3.5 h-3.5 opacity-50 hover:opacity-100 cursor-help transition-opacity" />
            </span>
          )}
        </p>
        <div className="text-2xl font-bold text-foreground">{typeof value === 'number' ? value.toLocaleString() : value}</div>
        <p className="text-xs text-muted-foreground mt-1 font-medium">{sub}</p>
      </div>
    </div>
  );
}

const GOVERNANCE_ROLES = ['dpo', 'auditor', 'compliance'];

export default function DashboardPage() {
  const { role, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Governance roles land on Shield, not Dashboard
  useEffect(() => {
    if (!authLoading && GOVERNANCE_ROLES.includes(role ?? '')) {
      router.replace('/shield');
    }
  }, [role, authLoading, router]);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get(ENDPOINTS.STATS);
      setStats(response.data);
    } catch {
      setError('Não foi possível carregar as estatísticas do dashboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Don't render dashboard while redirecting governance roles
  if (!authLoading && GOVERNANCE_ROLES.includes(role ?? '')) {
    return <div className="min-h-screen bg-background" />;
  }

  const interceptionRate = stats && (stats.total_executions + stats.total_violations) > 0
    ? Math.min(100, Math.round((stats.total_violations / (stats.total_executions + stats.total_violations)) * 100))
    : 0;

  const pieData = stats?.risk_distribution?.map(r => ({
    name: r.risk_level ?? 'undefined',
    value: Number(r.count),
    color: RISK_COLORS[r.risk_level ?? 'undefined'] ?? '#6b7280',
  })) ?? [];

  const postureData = stats?.posture_history?.map(p => ({
    name: new Date(p.snapshot_date).toLocaleDateString('pt-BR', { month: 'short', day: 'numeric' }),
    score: p.posture_score,
  })) ?? [];

  const totalRisk = pieData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">

        <PageHeader
          title="Dashboard"
          subtitle="Visão geral da plataforma"
          icon={<LayoutDashboard className="w-5 h-5" />}
          actions={
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </span>
                <span className="text-xs font-semibold text-emerald-500">Operacional</span>
              </div>
              <Link
                href="/reports"
                className="bg-secondary hover:bg-secondary/80 text-foreground border border-border text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                Gerar PDF de Auditoria
              </Link>
            </div>
          }
        />

        {/* Health Bar */}
        <div className="flex flex-wrap gap-4 p-4 bg-card border border-border rounded-xl items-center">
          <HealthStatus />
        </div>

        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <AlertTriangle className="w-8 h-8 text-destructive/70" />
            <p className="text-sm text-destructive font-medium">{error}</p>
            <button onClick={fetchStats} className="text-xs text-muted-foreground underline hover:text-foreground transition-colors">
              Tentar novamente
            </button>
          </div>
        ) : loading ? (
          <div className="space-y-4 animate-pulse">
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
              {[1,2,3,4,5,6].map(i => <div key={i} className="h-32 bg-secondary/50 border border-border rounded-xl" />)}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 h-[280px] bg-secondary/50 border border-border rounded-xl" />
              <div className="h-[280px] bg-secondary/50 border border-border rounded-xl" />
            </div>
            <div className="h-[200px] bg-secondary/50 border border-border rounded-xl" />
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
              <div className="lg:col-span-3 h-[360px] bg-secondary/50 border border-border rounded-xl" />
              <div className="h-[360px] bg-secondary/50 border border-border rounded-xl" />
            </div>
          </div>
        ) : (
          <div className="space-y-4">

            {/* ── SECTION 1 — Summary Cards ── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <SummaryCard
                icon={<Activity className="h-5 w-5 text-emerald-400" />}
                label="Processamento IA"
                value={stats?.total_executions ?? 0}
                sub="Calls processadas"
                color="border-emerald-500/20"
                href="/logs"
                tooltip="Volume total de prompts processados (LGPD Art. 37)."
              />
              <SummaryCard
                icon={<ShieldAlert className="h-5 w-5 text-rose-400" />}
                label="Violações OPA"
                value={stats?.total_violations ?? 0}
                sub="Bloqueios P0"
                color="border-rose-500/20"
                href="/approvals"
                tooltip="Incidentes mitigados automaticamente (LGPD Art. 46)."
              />
              <SummaryCard
                icon={<Coins className="h-5 w-5 text-violet-400" />}
                label="Consumo LLM"
                value={stats?.total_tokens ?? 0}
                sub={`≈ $${stats?.estimated_cost_usd ?? '0.00'}`}
                color="border-violet-500/20"
              />
              <SummaryCard
                icon={<Bot className="h-5 w-5 text-blue-400" />}
                label="Agentes Ativos"
                value={stats?.total_assistants ?? 0}
                sub="Modelos em Produção"
                color="border-blue-500/20"
                href="/assistants"
              />
              <SummaryCard
                icon={<Clock className="h-5 w-5 text-amber-400" />}
                label="Revisões Pendentes"
                value={stats?.pending_reviews ?? 0}
                sub="Aguardando aprovação"
                color="border-amber-500/20"
                href="/catalog"
                tooltip="Assistants no track de revisão aguardando decisão."
              />
              <SummaryCard
                icon={<FileWarning className="h-5 w-5 text-orange-400" />}
                label="Exceções Expirando"
                value={stats?.expiring_exceptions ?? 0}
                sub="Próximos 30 dias"
                color="border-orange-500/20"
                href="/exceptions"
                tooltip="Exceções de política que expiram nos próximos 30 dias."
              />
            </div>

            {/* ── SECTION 2 — Risk Posture ── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

              {/* Posture Score AreaChart */}
              <div className="lg:col-span-2 bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors flex flex-col min-h-[280px]">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      Postura de Segurança
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">Score de risco consolidado nos últimos 6 snapshots</p>
                  </div>
                </div>
                <div className="flex-1 w-full">
                  {postureData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={postureData} margin={{ top: 5, right: 0, bottom: 0, left: -25 }}>
                        <defs>
                          <linearGradient id="colorPosture" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.5} />
                        <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} dy={10} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} domain={[0, 100]} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'hsl(var(--card))',
                            borderColor: 'hsl(var(--border))',
                            borderRadius: '8px',
                            color: 'hsl(var(--foreground))',
                            padding: '10px 14px',
                            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
                          }}
                          formatter={(v: number) => [`${v}`, 'Score']}
                          cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '4 4' }}
                        />
                        <Area type="monotone" name="Posture Score" dataKey="score" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorPosture)" activeDot={{ r: 5, strokeWidth: 0, fill: '#10b981' }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground">
                      Sem histórico de postura disponível
                    </div>
                  )}
                </div>
              </div>

              {/* Risk Distribution Donut */}
              <div className="bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors flex flex-col min-h-[280px]">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-foreground">Distribuição de Risco</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Assistants por nível de risco</p>
                </div>
                <div className="flex-1 flex items-center justify-center">
                  {pieData.length > 0 ? (
                    <div className="relative w-full h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pieData}
                            cx="50%" cy="50%"
                            innerRadius={55} outerRadius={80}
                            paddingAngle={2}
                            dataKey="value"
                          >
                            {pieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              backgroundColor: 'hsl(var(--card))',
                              borderColor: 'hsl(var(--border))',
                              borderRadius: '8px',
                              color: 'hsl(var(--foreground))',
                              fontSize: '12px',
                            }}
                            formatter={(v: number, name: string) => [v, name]}
                          />
                          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '11px' }} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" style={{ top: '-12px' }}>
                        <span className="text-xl font-bold text-foreground">{totalRisk}</span>
                        <span className="text-xs text-muted-foreground">Total</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">Sem dados de risco</div>
                  )}
                </div>
              </div>
            </div>

            {/* ── SECTION 3 — Shadow AI Threats ── */}
            {stats?.top_shadow_ai && stats.top_shadow_ai.length > 0 && (
              <div className="bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                      Shadow AI — Ameaças Detectadas
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">Top 5 findings críticos do AI Shield</p>
                  </div>
                  <Link href="/shield" className="text-xs bg-secondary hover:bg-secondary/80 px-3 py-1.5 rounded-lg text-foreground border border-border flex items-center gap-1">
                    Ver todos <ArrowUpRight className="w-3 h-3" />
                  </Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-4">Assistente</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-4">Tipo</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2 pr-4">Severidade</th>
                        <th className="text-left text-muted-foreground font-semibold uppercase tracking-wider pb-2">Detectado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {stats.top_shadow_ai.map(f => (
                        <tr key={f.id} className="hover:bg-secondary/20 transition-colors">
                          <td className="py-2.5 pr-4 font-medium text-foreground truncate max-w-[200px]">{f.assistant_name}</td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{f.finding_type}</td>
                          <td className="py-2.5 pr-4">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${SEVERITY_COLORS[f.severity] ?? 'bg-secondary text-muted-foreground'}`}>
                              {f.severity.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2.5 text-muted-foreground">
                            {new Date(f.created_at).toLocaleDateString('pt-BR')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── SECTION 4 — Gateway Telemetry + Protection Rate ── */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">

              {/* Gateway Traffic Chart */}
              <div className="lg:col-span-3 bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors flex flex-col min-h-[360px]">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Gateway Telemetry</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">Tráfego limpo vs. requisições interceptadas no Edge</p>
                  </div>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                      <span className="w-2 h-2 rounded bg-emerald-500" /> Clean
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-medium text-rose-400">
                      <span className="w-2 h-2 rounded bg-rose-500" /> OPA Block
                    </div>
                  </div>
                </div>
                <div className="flex-1 w-full relative">
                  {stats?.usage_history ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={stats.usage_history} margin={{ top: 5, right: 0, bottom: 0, left: -25 }}>
                        <defs>
                          <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="colorViolations" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.5} />
                        <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} dy={10} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'hsl(var(--card))',
                            borderColor: 'hsl(var(--border))',
                            borderRadius: '8px',
                            color: 'hsl(var(--foreground))',
                            padding: '10px 14px',
                            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
                          }}
                          itemStyle={{ fontWeight: 600 }}
                          cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '4 4' }}
                        />
                        <Area type="monotone" name="Clean Executions" dataKey="requests" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorRequests)" activeDot={{ r: 5, strokeWidth: 0, fill: '#10b981' }} />
                        <Area type="monotone" name="Policy Blocks" dataKey="violations" stroke="#f43f5e" strokeWidth={2} fillOpacity={1} fill="url(#colorViolations)" activeDot={{ r: 5, strokeWidth: 0, fill: '#f43f5e' }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="absolute inset-0 bg-secondary/20 animate-pulse rounded-lg" />
                  )}
                </div>
              </div>

              {/* Protection Gauge */}
              <div className="bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors flex flex-col min-h-[360px]">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-foreground flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      Protection Rate
                    </div>
                    <span title="Índice de Eficácia de Controles (BCB 4.557).">
                      <Info className="w-4 h-4 opacity-50 hover:opacity-100 cursor-help transition-opacity" />
                    </span>
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">Impacto do motor OPA + DLP em tempo real</p>
                </div>

                <div className="flex-1 w-full flex flex-col items-center justify-center">
                  {stats ? (
                    <div className="relative w-44 h-44 flex items-center justify-center">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadialBarChart
                          cx="50%" cy="50%"
                          innerRadius="70%" outerRadius="100%"
                          barSize={10}
                          data={[{ name: 'Rate', value: interceptionRate, fill: interceptionRate > 5 ? '#f43f5e' : '#10b981' }]}
                          startAngle={90} endAngle={-270}
                        >
                          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                          <RadialBar background={{ fill: 'hsl(var(--secondary))' }} dataKey="value" cornerRadius={8} />
                        </RadialBarChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className={`text-2xl font-bold ${interceptionRate > 5 ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {interceptionRate}%
                        </span>
                        <span className="text-xs uppercase font-semibold text-muted-foreground tracking-wider mt-1">Interceptado</span>
                      </div>
                    </div>
                  ) : (
                    <div className="w-40 h-40 rounded-full border-8 border-secondary animate-pulse" />
                  )}

                  {stats && (
                    <div className="mt-6 text-center bg-secondary/30 border border-border/50 rounded-xl p-4 w-full">
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        <span className="text-rose-400 font-semibold">{stats.total_violations}</span> incidentes de{' '}
                        <span className="text-foreground font-semibold">{stats.total_executions + stats.total_violations}</span> transações
                      </p>
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        )}

      </div>
    </div>
  );
}

function HealthStatus() {
  const [status, setStatus] = useState<{ db: string; redis: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await api.get('/health');
        setStatus(res.data);
      } catch {
        toast('Falha Crítica: Conexão com infraestrutura perdida.', 'error');
        setStatus({ db: 'error', redis: 'error' });
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [toast]);

  const items = [
    { label: 'Database', key: 'db' as const, icon: <Database className="w-4 h-4" /> },
    { label: 'Redis Cache', key: 'redis' as const, icon: <Activity className="w-4 h-4" /> },
    { label: 'API Gateway', key: 'db' as const, icon: <Server className="w-4 h-4" /> },
    { label: 'Workers', key: 'redis' as const, icon: <Zap className="w-4 h-4" /> },
  ];

  return (
    <div className="flex flex-wrap items-center gap-6">
      {items.map((item, i) => {
        const up = status?.[item.key] === 'connected';
        return (
          <div key={i} className="flex items-center gap-2">
            {i > 0 && <div className="w-px h-4 bg-border mr-2" />}
            <span className={up ? 'text-emerald-500' : 'text-rose-500'}>{item.icon}</span>
            <span className="text-xs font-semibold text-foreground uppercase tracking-tight">{item.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${up ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
              {up ? 'UP' : 'DOWN'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
