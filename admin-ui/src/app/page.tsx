'use client';

import { useEffect, useState } from 'react';
import { Activity, ShieldCheck, Zap, Coins } from 'lucide-react';
import axios from 'axios';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

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

  return (
    <div className="flex-1 overflow-auto p-8 bg-background">
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground mt-2">
            Visão geral da plataforma GovAI e mitigação de riscos em tempo real.
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-secondary rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-card border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-all">
              <div className="flex flex-row items-center justify-between pb-2">
                <h3 className="text-sm font-medium text-muted-foreground">Execuções de IA</h3>
                <Activity className="h-4 w-4 text-blue-500" />
              </div>
              <div className="text-3xl font-bold">{stats?.total_executions.toLocaleString() || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Prompt calls processadas</p>
            </div>

            <div className="bg-card border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-all relative overflow-hidden group">
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-violet-500/10 rounded-full group-hover:bg-violet-500/20 transition-colors pointer-events-none" />
              <div className="flex flex-row items-center justify-between pb-2 relative z-10">
                <h3 className="text-sm font-medium text-muted-foreground">Tokens Processados</h3>
                <Coins className="h-4 w-4 text-violet-500" />
              </div>
              <div className="text-3xl font-bold relative z-10">{stats?.total_tokens?.toLocaleString() || 0}</div>
              <p className="text-xs text-violet-400 mt-1 font-medium relative z-10">≈ ${stats?.estimated_cost_usd || '0.00'}</p>
            </div>

            <div className="bg-card border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-all">
              <div className="flex flex-row items-center justify-between pb-2">
                <h3 className="text-sm font-medium text-muted-foreground">Assistentes Ativos</h3>
                <Zap className="h-4 w-4 text-amber-500" />
              </div>
              <div className="text-3xl font-bold">{stats?.total_assistants.toLocaleString() || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Agents em produção</p>
            </div>

            <div className="bg-card border border-destructive/30 rounded-xl p-6 shadow-sm hover:shadow-md transition-all bg-destructive/5 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-destructive/10 rounded-bl-full pointer-events-none" />
              <div className="flex flex-row items-center justify-between pb-2 relative z-10">
                <h3 className="text-sm font-medium text-destructive">Violações Bloqueadas</h3>
                <ShieldCheck className="h-4 w-4 text-destructive" />
              </div>
              <div className="text-3xl font-bold text-destructive relative z-10">{stats?.total_violations.toLocaleString() || 0}</div>
              <p className="text-xs text-destructive/80 mt-1 relative z-10">Interceptados pelo OPA</p>
            </div>
          </div>
        )}

        {/* Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-7 gap-6 mt-8">
          <div className="col-span-4 bg-card border border-border rounded-xl p-6 shadow-sm h-96 flex flex-col">
            <h3 className="font-semibold mb-6 flex items-center gap-2">
              <Activity className="w-5 h-5 text-blue-500" />
              Consumo vs Bloqueios OPA
            </h3>
            <div className="flex-1 w-full h-full min-h-0">
              {stats?.usage_history ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={stats.usage_history} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                    <XAxis dataKey="name" stroke="#737373" fontSize={12} tickLine={false} axisLine={false} dy={10} />
                    <YAxis stroke="#737373" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value: string | number) => `${value}`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#171717', borderColor: '#262626', borderRadius: '8px', color: '#fff' }}
                      itemStyle={{ color: '#fff' }}
                      cursor={{ stroke: '#262626', strokeWidth: 1 }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '12px', paddingTop: '20px' }} />
                    <Line type="monotone" name="Total Invocations" dataKey="requests" stroke="#3b82f6" strokeWidth={3} dot={{ r: 4, strokeWidth: 2 }} activeDot={{ r: 6 }} />
                    <Line type="monotone" name="Policy Violations" dataKey="violations" stroke="#ef4444" strokeWidth={3} dot={{ r: 4, strokeWidth: 2 }} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex bg-secondary/50 h-full rounded-lg animate-pulse" />
              )}
            </div>
          </div>

          <div className="col-span-3 bg-card border border-border rounded-xl p-6 shadow-sm h-96 flex flex-col">
            <h3 className="font-semibold mb-6 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
              Taxa de Interceptação
            </h3>
            <div className="flex-1 flex flex-col items-center justify-center relative">
              {stats ? (
                <>
                  {/* Fake donut chart representation using CSS */}
                  <div className="relative w-48 h-48 rounded-full border-[16px] border-emerald-500/20 flex items-center justify-center">
                    <div className="absolute inset-0 border-[16px] border-emerald-500 rounded-full" style={{ clipPath: 'polygon(50% 50%, 50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, 20% 0%)' }} />
                    <div className="text-center">
                      <div className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-br from-emerald-400 to-emerald-600">
                        {stats.total_executions > 0 ? Math.round((stats.total_violations / stats.total_executions) * 100) : 0}%
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 uppercase tracking-widest font-semibold">Bloqueios</div>
                    </div>
                  </div>
                  <p className="mt-8 text-sm text-center text-muted-foreground px-4">
                    De <strong className="text-foreground">{stats.total_executions}</strong> requisições, o motor OPA interceptou com sucesso <strong className="text-destructive">{stats.total_violations}</strong> violações no nível de proxy.
                  </p>
                </>
              ) : (
                <div className="w-48 h-48 rounded-full bg-secondary/50 animate-pulse" />
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
