'use client';

import { useEffect, useState } from 'react';
import { Activity, ShieldCheck, Zap, Coins } from 'lucide-react';
import axios from 'axios';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, RadialBarChart, RadialBar, PolarAngleAxis } from 'recharts';

import { API_BASE } from '@/lib/api';

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

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await axios.get(`${API_BASE}/v1/admin/stats`);
        setStats(response.data);
      } catch (error) {
        console.error("Error fetching stats:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  const interceptionRate = stats && stats.total_executions > 0
    ? Math.round((stats.total_violations / stats.total_executions) * 100)
    : 0;

  return (
    <div className="flex-1 overflow-auto p-8 bg-[url('/grid.svg')] bg-cover bg-center bg-no-repeat relative">
      <div className="absolute inset-0 bg-background/90 backdrop-blur-3xl z-0" />

      <div className="max-w-7xl mx-auto space-y-8 relative z-10">
        <div>
          <h2 className="text-3xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-emerald-600">
            System Dashboard
          </h2>
          <p className="text-muted-foreground mt-2 font-medium">
            Risk mitigation and telemetry overview in real-time.
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-secondary/30 border border-border/50 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Cards */}
            <div className="glass rounded-xl p-6 shadow-sm hover:shadow-lg hover:shadow-emerald-500/5 transition-all duration-300 relative overflow-hidden group">
              <div className="flex flex-row items-center justify-between pb-2">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Execuções de IA</h3>
                <Activity className="h-5 w-5 text-emerald-500" />
              </div>
              <div className="text-4xl font-black mt-2 text-foreground group-hover:text-emerald-400 transition-colors">
                {stats?.total_executions.toLocaleString() || 0}
              </div>
              <p className="text-xs text-muted-foreground mt-2 font-medium">Prompt calls processadas</p>
            </div>

            <div className="glass rounded-xl p-6 shadow-sm hover:shadow-lg hover:shadow-violet-500/5 transition-all duration-300 relative overflow-hidden group">
              <div className="absolute -right-10 -top-10 w-32 h-32 bg-violet-500/5 rounded-full blur-2xl group-hover:bg-violet-500/10 transition-colors pointer-events-none" />
              <div className="flex flex-row items-center justify-between pb-2 relative z-10">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Tokens Utilizados</h3>
                <Coins className="h-5 w-5 text-violet-500" />
              </div>
              <div className="text-4xl font-black mt-2 text-foreground group-hover:text-violet-400 transition-colors relative z-10">
                {stats?.total_tokens?.toLocaleString() || 0}
              </div>
              <p className="text-xs text-violet-400/80 mt-2 font-bold relative z-10 bg-violet-500/10 inline-block px-2 py-0.5 rounded-full">
                ≈ ${stats?.estimated_cost_usd || '0.00'}
              </p>
            </div>

            <div className="glass rounded-xl p-6 shadow-sm hover:shadow-lg hover:shadow-amber-500/5 transition-all duration-300">
              <div className="flex flex-row items-center justify-between pb-2">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Agents / RAG</h3>
                <Zap className="h-5 w-5 text-amber-500" />
              </div>
              <div className="text-4xl font-black mt-2 text-foreground group-hover:text-amber-400 transition-colors">
                {stats?.total_assistants.toLocaleString() || 0}
              </div>
              <p className="text-xs text-muted-foreground mt-2 font-medium">Modelos em Produção</p>
            </div>

            <div className="glass !border-destructive/30 rounded-xl p-6 shadow-[0_0_15px_-3px_rgba(239,68,68,0.1)] hover:shadow-[0_0_20px_-3px_rgba(239,68,68,0.2)] transition-all duration-300 relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-bl from-destructive/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              <div className="flex flex-row items-center justify-between pb-2 relative z-10">
                <h3 className="text-sm font-semibold text-destructive uppercase tracking-wider">Violações OPA</h3>
                <ShieldCheck className="h-5 w-5 text-destructive" />
              </div>
              <div className="text-4xl font-black mt-2 text-destructive relative z-10">
                {stats?.total_violations.toLocaleString() || 0}
              </div>
              <p className="text-xs text-destructive/80 mt-2 font-bold relative z-10 inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                Segurança Ativada
              </p>
            </div>
          </div>
        )}

        {/* Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-7 gap-6 mt-8">
          <div className="col-span-4 glass rounded-xl p-6 shadow-sm h-[400px] flex flex-col">
            <h3 className="font-bold mb-6 flex items-center gap-2 tracking-tight text-lg">
              <Activity className="w-5 h-5 text-emerald-500" />
              Gateway API Traffic Overview
            </h3>
            <div className="flex-1 w-full h-full min-h-0">
              {stats?.usage_history ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats.usage_history} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                    <defs>
                      <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorViolations" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="name" stroke="#a1a1aa" fontSize={12} tickLine={false} axisLine={false} dy={10} />
                    <YAxis stroke="#a1a1aa" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'rgba(24, 24, 27, 0.9)', borderColor: '#27272a', borderRadius: '8px', color: '#fff', backdropFilter: 'blur(8px)' }}
                      itemStyle={{ color: '#fff', fontWeight: 600 }}
                      cursor={{ stroke: '#52525b', strokeWidth: 1, strokeDasharray: '5 5' }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '12px', paddingTop: '20px', fontWeight: 600 }} />
                    <Area type="monotone" name="Clean Executions" dataKey="requests" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorRequests)" activeDot={{ r: 6, strokeWidth: 0, fill: '#10b981' }} />
                    <Area type="monotone" name="Policy Blocks (OPA)" dataKey="violations" stroke="#ef4444" strokeWidth={3} fillOpacity={1} fill="url(#colorViolations)" activeDot={{ r: 6, strokeWidth: 0, fill: '#ef4444' }} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex bg-secondary/30 h-full rounded-lg animate-pulse" />
              )}
            </div>
          </div>

          <div className="col-span-3 glass rounded-xl p-6 shadow-sm h-[400px] flex flex-col items-center relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-b from-transparent to-emerald-500/5 pointer-events-none" />
            <h3 className="font-bold w-full mb-2 flex items-center gap-2 tracking-tight text-lg relative z-10">
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
              Interception Rate (OPA)
            </h3>
            <p className="text-xs text-muted-foreground w-full mb-4 relative z-10">Percentagem de tráfego bloqueado pelo gateway de segurança antes de atingir as APIs externas.</p>

            <div className="flex-1 w-full flex flex-col items-center justify-center relative z-10">
              {stats ? (
                <ResponsiveContainer width={250} height={250}>
                  <RadialBarChart
                    cx="50%" cy="50%"
                    innerRadius="70%" outerRadius="100%"
                    barSize={16}
                    data={[{ name: 'Rate', value: interceptionRate, fill: '#10b981' }]}
                    startAngle={90} endAngle={-270}
                  >
                    <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                    <RadialBar
                      background={{ fill: '#27272a' }}
                      dataKey="value"
                      cornerRadius={10}
                    />
                    <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground font-black text-4xl">
                      {interceptionRate}%
                    </text>
                    <text x="50%" y="65%" textAnchor="middle" className="fill-muted-foreground font-bold text-[10px] tracking-widest uppercase">
                      Bloqueios
                    </text>
                  </RadialBarChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-48 h-48 rounded-full border-[10px] border-secondary/50 animate-pulse" />
              )}

              {stats && (
                <p className="mt-4 text-sm text-center font-medium bg-secondary/40 px-4 py-2 rounded-lg border border-border/50 text-muted-foreground">
                  <strong className="text-destructive font-bold">{stats.total_violations}</strong> violações contidas de <strong className="text-emerald-500 font-bold">{stats.total_executions}</strong> requisições totais.
                </p>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
