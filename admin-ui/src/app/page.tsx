'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ShieldCheck, Coins, ArrowUpRight, ShieldAlert, CreditCard, Bot, Info, Database, Server, Zap, AlertTriangle } from 'lucide-react';

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, RadialBarChart, RadialBar, PolarAngleAxis } from 'recharts';

import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';

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
      console.error("Error fetching stats:");
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
    <div className="flex-1 overflow-auto bg-background">
      <div className="max-w-7xl mx-auto p-4 md:p-8 space-y-6">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-black tracking-tight text-foreground flex items-center gap-3">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-emerald-600">
                GovAI
              </span>
              Security Command Center
            </h2>
            <p className="text-muted-foreground mt-1.5 font-medium text-sm">
              Real-time telemetry, risk mitigation, and OPA governance overview.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <span className="text-xs font-bold text-emerald-500 tracking-wider uppercase">System Operational</span>
            <Link href="/reports" className="ml-4 bg-secondary/50 hover:bg-secondary/70 text-foreground border border-border text-xs font-semibold px-4 py-2 rounded-full transition-all">
              Gerar PDF de Auditoria
            </Link>
          </div>
        </div>

        {/* Health Monitoring Section */}
        <div className="flex gap-4 p-4 bg-secondary/50 border border-border rounded-2xl relative z-10 items-center justify-between">
          <HealthStatus />
        </div>

        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 py-24">
            <AlertTriangle className="w-10 h-10 text-destructive/70" />
            <p className="text-sm text-destructive font-medium">{error}</p>
            <button onClick={fetchStats} className="text-xs text-muted-foreground underline hover:text-foreground transition-colors">Tentar novamente</button>
          </div>
        ) : loading ? (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-secondary/50 border border-border rounded-2xl" />
            ))}
            <div className="col-span-1 md:col-span-3 h-[400px] bg-secondary/50 border border-border rounded-2xl" />
            <div className="col-span-1 h-[400px] bg-secondary/50 border border-border rounded-2xl" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">

            {/* 1. Bento Box: Executions (Standard) */}
            <div className="bg-card border border-border rounded-2xl p-5 hover:border-border transition-all group flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                  <Activity className="h-5 w-5 text-emerald-400" />
                </div>
                <Link href="/logs" className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-secondary/50 hover:bg-secondary px-2 py-1 rounded text-foreground flex items-center gap-1">
                  Ver Logs <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>
              <div className="mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1 flex items-center justify-between">
                  Processamento de IA
                  <span title="Volume total de prompts processados. Metrificação exigida para rastreabilidade de acessos (LGPD Art. 37)."><Info className="w-3.5 h-3.5 opacity-50 hover:opacity-100 cursor-help transition-opacity" /></span>
                </p>
                <div className="text-3xl font-black text-foreground">{stats?.total_executions.toLocaleString() || 0}</div>
                <p className="text-xs text-emerald-400/80 mt-1 font-medium bg-emerald-500/10 inline-block px-2 py-0.5 rounded">Calls processadas</p>
              </div>
            </div>

            {/* 2. Bento Box: Policy Violations (Highlighted/Danger) */}
            <div className="bg-gradient-to-br from-rose-950/40 to-background border border-rose-500/20 rounded-2xl p-5 hover:border-rose-500/40 transition-all group flex flex-col justify-between relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-rose-500/10 blur-3xl pointer-events-none" />
              <div className="flex justify-between items-start relative z-10">
                <div className="w-10 h-10 rounded-xl bg-rose-500/10 flex items-center justify-center border border-rose-500/20">
                  <ShieldAlert className="h-5 w-5 text-rose-500" />
                </div>
                <Link href="/approvals" className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-rose-500/20 hover:bg-rose-500/40 px-2 py-1 rounded text-rose-200 border border-rose-500/20 flex items-center gap-1">
                  Quarentena <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>
              <div className="mt-4 relative z-10">
                <p className="text-xs text-rose-400/80 font-semibold uppercase tracking-wider mb-1 flex items-center justify-between">
                  Violações OPA Barradas
                  <span title="Incidentes de segurança mitigados automaticamente. Previne vazamento de PII (LGPD Art. 46) e ataques (BCB 4.557 Art. 21)."><Info className="w-3.5 h-3.5 opacity-60 hover:opacity-100 cursor-help text-rose-300 transition-opacity" /></span>
                </p>
                <div className="text-3xl font-black text-foreground flex items-baseline gap-2">
                  {stats?.total_violations.toLocaleString() || 0}
                  <span className="text-sm font-medium text-rose-400/60 bg-rose-500/10 px-1.5 py-0.5 rounded">Bloqueios P0</span>
                </div>
              </div>
            </div>

            {/* 3. Bento Box: Tokens / Cost */}
            <div className="bg-card border border-border rounded-2xl p-5 hover:border-border transition-all group flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20">
                  <Coins className="h-5 w-5 text-violet-400" />
                </div>
              </div>
              <div className="mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">Consumo LLM</p>
                <div className="text-3xl font-black text-foreground">{stats?.total_tokens?.toLocaleString() || 0}</div>
                <p className="text-xs text-violet-400/80 mt-1 font-bold bg-violet-500/10 inline-flex items-center gap-1 px-2 py-0.5 rounded">
                  <CreditCard className="w-3 h-3" /> ≈ ${stats?.estimated_cost_usd || '0.00'}
                </p>
              </div>
            </div>

            {/* 4. Bento Box: Agents */}
            <div className="bg-card border border-border rounded-2xl p-5 hover:border-border transition-all group flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center border border-blue-500/20">
                  <Bot className="h-5 w-5 text-blue-400" />
                </div>
                <Link href="/assistants" className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-secondary/50 hover:bg-secondary px-2 py-1 rounded text-foreground flex items-center gap-1">
                  Gerenciar <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>
              <div className="mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">Agentes de IA Ativos</p>
                <div className="text-3xl font-black text-foreground">{stats?.total_assistants.toLocaleString() || 0}</div>
                <p className="text-xs text-blue-400/80 mt-1 font-medium bg-blue-500/10 inline-block px-2 py-0.5 rounded">Modelos em Prod</p>
              </div>
            </div>

            {/* 5. Bento Box: System Status (Real-time Health) */}
            <SystemStatusCard />

            {/* 5. Bento Box: Gateway Traffic Chart (Large) */}
            <div className="md:col-span-3 bg-card border border-border rounded-2xl p-6 hover:border-border transition-all flex flex-col min-h-[400px]">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-bold text-foreground flex items-center gap-2 text-lg">
                    Gateway Telemetry
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">Tráfego limpo vs Requisições interceptadas no Edge.</p>
                </div>
                <div className="flex gap-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-400"><span className="w-2 h-2 rounded bg-emerald-500"></span> Clean</div>
                  <div className="flex items-center gap-2 text-xs font-medium text-rose-500"><span className="w-2 h-2 rounded bg-rose-500"></span> OPA Block</div>
                </div>
              </div>

              <div className="flex-1 w-full relative">
                {stats?.usage_history ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={stats.usage_history} margin={{ top: 5, right: 0, bottom: 0, left: -25 }}>
                      <defs>
                        <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorViolations" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} opacity={0.5} />
                      <XAxis dataKey="name" stroke="#666" fontSize={11} tickLine={false} axisLine={false} dy={10} />
                      <YAxis stroke="#666" fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '12px', color: 'hsl(var(--foreground))', padding: '12px', boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)' }}
                        itemStyle={{ fontWeight: 600 }}
                        cursor={{ stroke: '#555', strokeWidth: 1, strokeDasharray: '4 4' }}
                      />
                      <Area type="monotone" name="Clean Executions" dataKey="requests" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorRequests)" activeDot={{ r: 6, strokeWidth: 0, fill: '#10b981' }} />
                      <Area type="monotone" name="Policy Blocks" dataKey="violations" stroke="#f43f5e" strokeWidth={3} fillOpacity={1} fill="url(#colorViolations)" activeDot={{ r: 6, strokeWidth: 0, fill: '#f43f5e' }} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="absolute inset-0 bg-card animate-pulse rounded-lg border border-border/50" />
                )}
              </div>
            </div>

            {/* 6. Bento Box: Protection Gauge (Vertical layout) */}
            <div className="bg-card border border-border rounded-2xl p-6 hover:border-border transition-all flex flex-col min-h-[400px] relative overflow-hidden group">
              <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-emerald-950/40 to-transparent pointer-events-none" />

              <div className="mb-4">
                <h3 className="font-bold text-foreground text-lg flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    Protection Rate
                  </div>
                  <span title="Índice de Eficácia de Controles (IEC). Demonstração matemática de prevenção exigida pela Resolução BCB 4.557 de Gerenciamento de Risco Cibernético."><Info className="w-4 h-4 opacity-50 hover:opacity-100 cursor-help transition-opacity" /></span>
                </h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">Impacto do motor OPA + DLP em tempo real.</p>
              </div>

              <div className="flex-1 w-full flex flex-col items-center justify-center relative z-10 pt-4">
                {stats ? (
                  <div className="relative w-48 h-48 flex items-center justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <RadialBarChart
                        cx="50%" cy="50%"
                        innerRadius="70%" outerRadius="100%"
                        barSize={12}
                        data={[{ name: 'Rate', value: interceptionRate, fill: interceptionRate > 5 ? '#ef4444' : '#10b981' }]}
                        startAngle={90} endAngle={-270}
                      >
                        <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                        <RadialBar background={{ fill: '#222' }} dataKey="value" cornerRadius={10} />
                      </RadialBarChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className={`text-4xl font-black ${interceptionRate > 5 ? 'text-rose-500' : 'text-emerald-400'}`}>
                        {interceptionRate}%
                      </span>
                      <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest mt-1">Interceptado</span>
                    </div>
                  </div>
                ) : (
                  <div className="w-40 h-40 rounded-full border-[8px] border-[#222] animate-pulse" />
                )}

                {stats && (
                  <div className="mt-8 text-center bg-card border border-border/50 rounded-xl p-4 w-full">
                    <p className="text-sm text-muted-foreground font-medium leading-tight">
                      <span className="text-rose-400 font-bold">{stats.total_violations}</span> incidentes isolados de um total de <span className="text-foreground font-bold">{stats.total_executions + stats.total_violations}</span> transações.
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
    <div className="flex items-center gap-6">
      <div className="flex items-center gap-2">
        <Database className={`w-4 h-4 ${status?.db === 'connected' ? 'text-emerald-500' : 'text-rose-500'}`} />
        <span className="text-xs font-bold text-foreground uppercase tracking-tighter">Database</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-black ${status?.db === 'connected' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
          {status?.db === 'connected' ? 'UP' : 'DOWN'}
        </span>
      </div>
      <div className="w-px h-4 bg-border" />
      <div className="flex items-center gap-2">
        <Activity className={`w-4 h-4 ${status?.redis === 'connected' ? 'text-emerald-500' : 'text-rose-500'}`} />
        <span className="text-xs font-bold text-foreground uppercase tracking-tighter">Redis Cache</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-black ${status?.redis === 'connected' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
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
    <div className="bg-card border border-border rounded-2xl p-5 hover:border-border transition-all group flex flex-col justify-between overflow-hidden relative">
      <div className="absolute top-0 right-0 p-2 opacity-20 group-hover:opacity-100 transition-opacity">
        <Zap className="w-4 h-4 text-indigo-400" />
      </div>
      <div className="flex justify-between items-start">
        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
          <Server className="h-5 w-5 text-indigo-400" />
        </div>
      </div>
      <div className="mt-4">
        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-3">Infraestrutura</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between bg-secondary/20 p-2 rounded-lg border border-border/50">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${status?.db === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-[10px] font-black tracking-widest text-foreground/50 uppercase">Database</span>
            </div>
            <span className={`text-[9px] font-black ${status?.db === 'connected' ? 'text-emerald-400' : 'text-red-400'}`}>
              {status?.db === 'connected' ? 'OPERATIONAL' : 'DEGRADED'}
            </span>
          </div>
          <div className="flex items-center justify-between bg-secondary/20 p-2 rounded-lg border border-border/50">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${status?.redis === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-[10px] font-black tracking-widest text-foreground/50 uppercase">Redis</span>
            </div>
            <span className={`text-[9px] font-black ${status?.redis === 'connected' ? 'text-emerald-400' : 'text-red-400'}`}>
              {status?.redis === 'connected' ? 'OPERATIONAL' : 'DEGRADED'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
