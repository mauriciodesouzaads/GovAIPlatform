'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ShieldCheck, Coins, ArrowUpRight, ShieldAlert, CreditCard, Bot, Info, Database, Server, Zap, AlertTriangle, LayoutDashboard } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, RadialBarChart, RadialBar, PolarAngleAxis } from 'recharts';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';

interface DashboardStats {
  total_assistants: number;
  total_executions: number;
  total_violations: number;
  total_tokens?: number;
  estimated_cost_usd?: string;
  usage_history?: { name: string; requests: number; violations: number; }[];
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const interceptionRate = stats && (stats.total_executions + stats.total_violations) > 0
    ? Math.min(100, Math.round((stats.total_violations / (stats.total_executions + stats.total_violations)) * 100))
    : 0;

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

        {/* Health Monitoring */}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-secondary/50 border border-border rounded-xl" />
            ))}
            <div className="col-span-1 lg:col-span-3 h-[360px] bg-secondary/50 border border-border rounded-xl" />
            <div className="col-span-1 h-[360px] bg-secondary/50 border border-border rounded-xl" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

            {/* Executions */}
            <div className="bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors group flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                  <Activity className="h-5 w-5 text-emerald-400" />
                </div>
                <Link href="/logs" className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-secondary hover:bg-secondary/80 px-2 py-1 rounded text-foreground flex items-center gap-1">
                  Ver Logs <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>
              <div className="mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1 flex items-center justify-between">
                  Processamento de IA
                  <span title="Volume total de prompts processados (LGPD Art. 37).">
                    <Info className="w-3.5 h-3.5 opacity-50 hover:opacity-100 cursor-help transition-opacity" />
                  </span>
                </p>
                <div className="text-2xl font-bold text-foreground">{stats?.total_executions.toLocaleString() ?? 0}</div>
                <p className="text-xs text-emerald-400 mt-1 font-medium">Calls processadas</p>
              </div>
            </div>

            {/* Policy Violations */}
            <div className="bg-card border border-rose-500/20 rounded-xl p-5 hover:border-rose-500/40 transition-colors group flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div className="w-10 h-10 rounded-xl bg-rose-500/10 flex items-center justify-center border border-rose-500/20">
                  <ShieldAlert className="h-5 w-5 text-rose-400" />
                </div>
                <Link href="/approvals" className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-rose-500/10 hover:bg-rose-500/20 px-2 py-1 rounded text-rose-300 border border-rose-500/20 flex items-center gap-1">
                  Quarentena <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>
              <div className="mt-4">
                <p className="text-xs text-rose-400/70 font-semibold uppercase tracking-wider mb-1 flex items-center justify-between">
                  Violações OPA
                  <span title="Incidentes mitigados automaticamente (LGPD Art. 46, BCB 4.557 Art. 21).">
                    <Info className="w-3.5 h-3.5 opacity-60 hover:opacity-100 cursor-help text-rose-300 transition-opacity" />
                  </span>
                </p>
                <div className="text-2xl font-bold text-foreground">{stats?.total_violations.toLocaleString() ?? 0}</div>
                <p className="text-xs text-rose-400 mt-1 font-medium">Bloqueios P0</p>
              </div>
            </div>

            {/* Tokens / Cost */}
            <div className="bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors group flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20">
                  <Coins className="h-5 w-5 text-violet-400" />
                </div>
              </div>
              <div className="mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">Consumo LLM</p>
                <div className="text-2xl font-bold text-foreground">{stats?.total_tokens?.toLocaleString() ?? 0}</div>
                <p className="text-xs text-violet-400 mt-1 font-medium flex items-center gap-1">
                  <CreditCard className="w-3 h-3" /> ≈ ${stats?.estimated_cost_usd ?? '0.00'}
                </p>
              </div>
            </div>

            {/* Agents */}
            <div className="bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors group flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center border border-blue-500/20">
                  <Bot className="h-5 w-5 text-blue-400" />
                </div>
                <Link href="/assistants" className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-secondary hover:bg-secondary/80 px-2 py-1 rounded text-foreground flex items-center gap-1">
                  Gerenciar <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>
              <div className="mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">Agentes de IA Ativos</p>
                <div className="text-2xl font-bold text-foreground">{stats?.total_assistants.toLocaleString() ?? 0}</div>
                <p className="text-xs text-blue-400 mt-1 font-medium">Modelos em Produção</p>
              </div>
            </div>

            {/* System Status */}
            <SystemStatusCard />

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
        )}
      </div>
    </div>
  );
}

function HealthStatus() {
  const [status, setStatus] = useState<{ db: string; redis: string } | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await api.get('/health');
        setStatus(res.data);
      } catch {
        setStatus({ db: 'error', redis: 'error' });
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-2">
        <Database className={`w-4 h-4 ${status?.db === 'connected' ? 'text-emerald-500' : 'text-rose-500'}`} />
        <span className="text-xs font-semibold text-foreground uppercase tracking-tight">Database</span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${status?.db === 'connected' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
          {status?.db === 'connected' ? 'UP' : 'DOWN'}
        </span>
      </div>
      <div className="w-px h-4 bg-border" />
      <div className="flex items-center gap-2">
        <Activity className={`w-4 h-4 ${status?.redis === 'connected' ? 'text-emerald-500' : 'text-rose-500'}`} />
        <span className="text-xs font-semibold text-foreground uppercase tracking-tight">Redis Cache</span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${status?.redis === 'connected' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
          {status?.redis === 'connected' ? 'UP' : 'DOWN'}
        </span>
      </div>
    </div>
  );
}

function SystemStatusCard() {
  const [status, setStatus] = useState<{ db: string; redis: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const check = async () => {
      try {
        const res = await api.get('/health');
        setStatus(res.data);
      } catch {
        toast('Falha Crítica: Conexão com infraestrutura perdida.', 'error');
        setStatus({ db: 'error', redis: 'error' });
      }
    };
    check();
  }, [toast]);

  return (
    <div className="bg-card border border-border rounded-xl p-5 hover:border-primary/20 transition-colors flex flex-col justify-between">
      <div className="flex justify-between items-start">
        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
          <Server className="h-5 w-5 text-indigo-400" />
        </div>
        <Zap className="w-4 h-4 text-indigo-400/40" />
      </div>
      <div className="mt-4">
        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-3">Infraestrutura</p>
        <div className="space-y-2">
          <div className="flex items-center justify-between bg-secondary/30 p-2.5 rounded-lg border border-border/50">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${status?.db === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Database</span>
            </div>
            <span className={`text-xs font-semibold ${status?.db === 'connected' ? 'text-emerald-400' : 'text-rose-400'}`}>
              {status?.db === 'connected' ? 'OPERATIONAL' : 'DEGRADED'}
            </span>
          </div>
          <div className="flex items-center justify-between bg-secondary/30 p-2.5 rounded-lg border border-border/50">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${status?.redis === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Redis</span>
            </div>
            <span className={`text-xs font-semibold ${status?.redis === 'connected' ? 'text-emerald-400' : 'text-rose-400'}`}>
              {status?.redis === 'connected' ? 'OPERATIONAL' : 'DEGRADED'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
