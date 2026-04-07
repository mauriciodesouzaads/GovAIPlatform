'use client';

import { useEffect, useState } from 'react';
import { Shield, Clock, AlertTriangle } from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/Badge';

interface AuditLog {
    id: string;
    action: string;
    metadata: Record<string, unknown>;
    trace_id: string;
    user_email: string;
    created_at: string;
}

export default function AuditLogsPage() {
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);

    const fetchLogs = async () => {
        setLoading(true);
        setError(false);
        try {
            const response = await api.get(`${ENDPOINTS.AUDIT_LOGS}?page=${page}&limit=20`);
            setLogs(response.data.logs);
            setTotalPages(response.data.pagination.pages);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page]);

    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
                <PageHeader
                    title="Audit Logs"
                    subtitle="Registro de auditoria imutável"
                    icon={<Shield className="w-5 h-5" />}
                />

                {error && !loading && (
                    <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-8 text-center space-y-3">
                        <AlertTriangle className="w-8 h-8 text-destructive mx-auto" />
                        <h3 className="text-lg font-semibold text-foreground">Erro ao carregar logs</h3>
                        <p className="text-sm text-muted-foreground">Não foi possível conectar ao servidor.</p>
                        <button
                            onClick={() => { setError(false); fetchLogs(); }}
                            className="text-sm text-primary hover:underline"
                        >
                            Tentar novamente
                        </button>
                    </div>
                )}

                <div className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="border-b border-border bg-secondary/40">
                                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Timestamp</th>
                                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Action</th>
                                    <th className="hidden md:table-cell px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Trace ID</th>
                                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    Array.from({ length: 8 }).map((_, i) => (
                                        <tr key={i} className="border-b border-border/50">
                                            <td className="px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse w-36" /></td>
                                            <td className="px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse w-28" /></td>
                                            <td className="hidden md:table-cell px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse w-48" /></td>
                                            <td className="px-4 py-3"><div className="h-4 bg-secondary/60 rounded animate-pulse w-8 mx-auto" /></td>
                                        </tr>
                                    ))
                                ) : logs.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} className="px-4 py-12 text-center text-sm text-muted-foreground">
                                            Nenhum log encontrado para esta organização.
                                        </td>
                                    </tr>
                                ) : (
                                    logs.map((log) => (
                                        <tr key={log.id} className="border-b border-border/50 last:border-0 hover:bg-secondary/30 transition-colors">
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-2 text-sm text-foreground">
                                                    <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                                    {new Date(log.created_at).toLocaleString('pt-BR')}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3">
                                                <Badge
                                                    variant={
                                                        log.action === 'EXIT_GOVERNED_PERIMETER' ? 'warning' :
                                                        log.action.includes('VIOLATION') ? 'error' :
                                                        log.action.includes('SUCCESS') ? 'success' : 'info'
                                                    }
                                                >
                                                    {log.action === 'EXIT_GOVERNED_PERIMETER'
                                                        ? 'SAÍDA DO PERÍMETRO'
                                                        : log.action.replace(/_/g, ' ')}
                                                </Badge>
                                            </td>
                                            <td className="hidden md:table-cell px-4 py-3 font-mono text-xs text-muted-foreground">
                                                {log.trace_id}
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex items-center justify-center">
                                                    <div className={`w-2 h-2 rounded-full ${
                                                        log.action === 'EXIT_GOVERNED_PERIMETER' ? 'bg-amber-500' :
                                                        log.action.includes('VIOLATION') ? 'bg-rose-500' : 'bg-emerald-500'
                                                    }`} />
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div className="px-4 py-3 border-t border-border/50 bg-secondary/20 flex justify-between items-center">
                        <p className="text-xs text-muted-foreground">Página {page} de {totalPages}</p>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                disabled={page === 1}
                                className="px-3 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded text-xs text-foreground disabled:opacity-40 transition-colors"
                            >
                                Anterior
                            </button>
                            <button
                                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                disabled={page === totalPages}
                                className="px-3 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded text-xs text-foreground disabled:opacity-40 transition-colors"
                            >
                                Próxima
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
