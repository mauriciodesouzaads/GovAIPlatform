'use client';

import { useEffect, useState } from 'react';
import { Activity, ShieldCheck, Zap } from 'lucide-react';
import axios from 'axios';

interface DashboardStats {
  total_assistants: number;
  total_executions: number;
  total_violations: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // In a real app, orgId would come from Auth Context
    const fetchStats = async () => {
      try {
        const response = await axios.get('http://localhost:3000/v1/admin/stats', {
          headers: { 'x-org-id': '00000000-0000-0000-0000-000000000001' }
        });
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
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground mt-2">
            Visão geral da plataforma GovAI e mitigação de riscos em tempo real.
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-pulse">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-32 bg-secondary rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
              <div className="flex flex-row items-center justify-between pb-2">
                <h3 className="text-sm font-medium text-muted-foreground">Execuções de IA</h3>
                <Activity className="h-4 w-4 text-blue-500" />
              </div>
              <div className="text-3xl font-bold">{stats?.total_executions.toLocaleString() || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Prompt calls processadas</p>
            </div>

            <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
              <div className="flex flex-row items-center justify-between pb-2">
                <h3 className="text-sm font-medium text-muted-foreground">Assistentes Ativos</h3>
                <Zap className="h-4 w-4 text-amber-500" />
              </div>
              <div className="text-3xl font-bold">{stats?.total_assistants.toLocaleString() || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Agents em produção</p>
            </div>

            <div className="bg-card border border-destructive/20 rounded-xl p-6 shadow-sm">
              <div className="flex flex-row items-center justify-between pb-2">
                <h3 className="text-sm font-medium text-destructive">Violações Bloqueadas</h3>
                <ShieldCheck className="h-4 w-4 text-destructive" />
              </div>
              <div className="text-3xl font-bold text-destructive">{stats?.total_violations.toLocaleString() || 0}</div>
              <p className="text-xs text-destructive/80 mt-1">Jailbreaks e PII interceptados (OPA)</p>
            </div>
          </div>
        )}

        {/* Charts placeholder */}
        <div className="grid grid-cols-1 lg:grid-cols-7 gap-6 mt-8">
          <div className="col-span-4 bg-card border border-border rounded-xl p-6 shadow-sm h-96 flex flex-col items-center justify-center text-muted-foreground">
            Gráfico de Consumo x Tempo (Em breve)
          </div>
          <div className="col-span-3 bg-card border border-border rounded-xl p-6 shadow-sm h-96 flex flex-col">
            <h3 className="font-semibold mb-4">Últimas Violações OPA</h3>
            <div className="flex-1 overflow-y-auto space-y-4 pr-2">
              <div className="text-sm text-center text-muted-foreground pt-10">Consulte a aba Audit Logs para ver os bloqueios recentes.</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
