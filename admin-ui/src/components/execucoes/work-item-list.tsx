'use client';

import { useState, useMemo } from 'react';
import { Activity } from 'lucide-react';
import { useRuntimeClient } from '@/hooks/execucoes/use-runtime-client';
import { useWorkItems } from '@/hooks/execucoes/use-work-items';
import { WorkItemCard } from './work-item-card';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';

const STATUS_FILTERS = ['all', 'in_progress', 'pending', 'done', 'failed', 'cancelled'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

const STATUS_LABELS: Record<string, string> = {
    all: 'Todas',
    in_progress: 'Em andamento',
    pending: 'Aguardando',
    done: 'Concluídas',
    failed: 'Falharam',
    cancelled: 'Canceladas',
};

const RUNTIME_OPTIONS = [
    { value: 'all', label: 'Todos runtimes' },
    { value: 'claude_code_official', label: 'Claude Code' },
    { value: 'openclaude', label: 'OpenClaude' },
    { value: 'aider', label: 'Aider' },
];

/**
 * Main list view for /execucoes. Filters at the top, paginated card
 * list below. Auto-refreshes every 5s while the tab is visible (the
 * useWorkItems hook handles visibilitychange).
 */
export function WorkItemList() {
    const client = useRuntimeClient();
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [runtimeFilter, setRuntimeFilter] = useState<string>('all');

    const filters = useMemo(() => ({
        // Top-level only — subagents render inside their parent.
        parent_work_item_id: null as string | null,
        ...(statusFilter !== 'all' ? { status: [statusFilter] } : {}),
        ...(runtimeFilter !== 'all' ? { runtime_profile_slug: runtimeFilter } : {}),
        limit: 50,
    }), [statusFilter, runtimeFilter]);

    const { items, loading, total } = useWorkItems(client, filters);

    return (
        <div className="space-y-4 max-w-5xl mx-auto">
            {/* Filter bar */}
            <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-0.5 p-0.5 bg-card/40 rounded-lg border border-border/40">
                    {STATUS_FILTERS.map(s => (
                        <button
                            key={s}
                            onClick={() => setStatusFilter(s)}
                            className={cn(
                                'text-[11px] px-3 py-1 rounded transition-colors',
                                statusFilter === s
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {STATUS_LABELS[s]}
                        </button>
                    ))}
                </div>

                <select
                    value={runtimeFilter}
                    onChange={e => setRuntimeFilter(e.target.value)}
                    className="bg-card/40 border border-border/40 rounded text-xs px-2 py-1.5 text-foreground/90 focus:outline-none focus:ring-1 focus:ring-primary/40"
                    aria-label="Filtrar por runtime"
                >
                    {RUNTIME_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>

                {total !== null && (
                    <span className="text-[11px] text-muted-foreground/70 ml-auto">
                        {total} {total === 1 ? 'execução' : 'execuções'}
                    </span>
                )}
            </div>

            {/* List */}
            {loading && items.length === 0 ? (
                <ListSkeleton />
            ) : items.length === 0 ? (
                <EmptyState
                    icon={<Activity className="w-6 h-6" />}
                    title="Nenhuma execução"
                    description="Inicie uma conversa governada — todo trabalho dos agentes aparecerá aqui."
                />
            ) : (
                <div className="space-y-2">
                    {items.map(item => (
                        <WorkItemCard key={item.id} item={item} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ListSkeleton() {
    return (
        <div className="space-y-2">
            {[0, 1, 2, 3, 4].map(i => (
                <div
                    key={i}
                    className="bg-card/30 border border-border/40 rounded-lg px-4 py-3 animate-pulse"
                >
                    <div className="flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-card/60 shrink-0" />
                        <div className="flex-1 space-y-1.5">
                            <div className="h-3 bg-card/60 rounded w-3/4" />
                            <div className="h-2 bg-card/40 rounded w-1/4" />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
