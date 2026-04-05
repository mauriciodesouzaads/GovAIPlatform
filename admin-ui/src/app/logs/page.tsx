'use client';

import { useEffect, useState } from 'react';
import { Shield, Clock } from 'lucide-react';
import api, { ENDPOINTS } from '@/lib/api';

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
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);

    useEffect(() => {
        const fetchLogs = async () => {
            setLoading(true);
            try {
                const response = await api.get(`${ENDPOINTS.AUDIT_LOGS}?page=${page}&limit=20`);
                setLogs(response.data.logs);
                setTotalPages(response.data.pagination.pages);
            } catch {
                console.error("Error fetching audit logs");
            } finally {
                setLoading(false);
            }
        };

        fetchLogs();
    }, [page]);

    return (
        <div className="flex-1 overflow-auto p-4 md:p-8 bg-background">
            <div className="max-w-7xl mx-auto space-y-6">
                <div className="flex justify-between items-end">
                    <div>
                        <h2 className="text-2xl font-bold text-foreground flex items-center gap-3">
                            <Shield className="h-8 w-8 text-emerald-500" />
                            Logs de Auditoria
                        </h2>
                        <p className="text-muted-foreground mt-1 font-medium">
                            Rastreabilidade completa de todas as interações e violações de política sob conformidade LGPD/GDPR.
                        </p>
                    </div>
                </div>

                <div className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-border bg-secondary/30">
                                    <th className="p-4 text-xs font-bold uppercase tracking-widest text-muted-foreground">Timestamp</th>
                                    <th className="p-4 text-xs font-bold uppercase tracking-widest text-muted-foreground">Action</th>
                                    <th className="p-4 text-xs font-bold uppercase tracking-widest text-muted-foreground">Trace ID</th>
                                    <th className="p-4 text-xs font-bold uppercase tracking-widest text-muted-foreground">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/30">
                                {loading ? (
                                    Array.from({ length: 5 }).map((_, i) => (
                                        <tr key={i} className="animate-pulse">
                                            <td colSpan={4} className="p-8 bg-secondary/30"></td>
                                        </tr>
                                    ))
                                ) : logs.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} className="p-12 text-center text-muted-foreground italic">
                                            Nenhum log encontrado para esta organização.
                                        </td>
                                    </tr>
                                ) : (
                                    logs.map((log) => (
                                        <tr key={log.id} className="hover:bg-secondary/30 transition-colors group">
                                            <td className="p-4">
                                                <div className="flex items-center gap-2 text-sm text-foreground font-medium">
                                                    <Clock className="w-4 h-4 text-muted-foreground" />
                                                    {new Date(log.created_at).toLocaleString('pt-BR')}
                                                </div>
                                            </td>
                                            <td className="p-4">
                                                <span className={`px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest ${log.action.includes('VIOLATION') ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' :
                                                    log.action.includes('SUCCESS') ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                                                        'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                                    }`}>
                                                    {log.action}
                                                </span>
                                            </td>
                                            <td className="p-4 font-mono text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                                                {log.trace_id}
                                            </td>
                                            <td className="p-4 text-center">
                                                <div className="flex items-center justify-center">
                                                    <div className={`w-2 h-2 rounded-full animate-pulse shadow-[0_0_8px] ${log.action.includes('VIOLATION') ? 'bg-rose-500 shadow-rose-500' : 'bg-emerald-500 shadow-emerald-500'}`} />
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div className="p-4 border-t border-border/50 bg-secondary/30 flex justify-between items-center">
                        <p className="text-xs text-muted-foreground">
                            Página {page} de {totalPages}
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                disabled={page === 1}
                                className="px-3 py-1 bg-secondary/50 rounded text-xs text-foreground disabled:opacity-30"
                            >
                                Anterior
                            </button>
                            <button
                                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                disabled={page === totalPages}
                                className="px-3 py-1 bg-secondary/50 rounded text-xs text-foreground disabled:opacity-30"
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
