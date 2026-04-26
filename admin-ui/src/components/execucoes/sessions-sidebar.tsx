'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Search, Plus } from 'lucide-react';
import { useRuntimeClient } from '@/hooks/execucoes/use-runtime-client';
import { useWorkItems } from '@/hooks/execucoes/use-work-items';
import { StatusBadge } from './status-badge';
import { RuntimeBadge } from './runtime-badge';
import { cn } from '@/lib/utils';
import type { RuntimeWorkItemSummary } from '@/types/runtime-admin';

/**
 * Left rail listing recent runs grouped by recency. Mirrors the
 * Claude Code Desktop sessions sidebar:
 *
 *   ATIVAS               → in_progress + pending
 *   HOJE / ONTEM /
 *   ESTA SEMANA / ANTES  → terminal runs by created_at distance
 *
 * Click → navigates to /execucoes/<id>. Active route highlights with
 * a left accent border (same pattern the global Sidebar already uses
 * for its NavItem).
 */
export function SessionsSidebar() {
    const client = useRuntimeClient();
    const { items, loading } = useWorkItems(client, {
        // Top-level only — subagents render inside their parent's detail.
        parent_work_item_id: null,
        limit: 100,
    });
    const params = useParams();
    const activeId = (params?.id as string | undefined) ?? null;

    const [search, setSearch] = useState('');

    const filtered = useMemo<RuntimeWorkItemSummary[]>(() => {
        const q = search.trim().toLowerCase();
        if (!q) return items;
        return items.filter(i =>
            i.title.toLowerCase().includes(q) ||
            i.id.toLowerCase().includes(q),
        );
    }, [items, search]);

    const grouped = useMemo(() => groupByRecency(filtered), [filtered]);

    return (
        <div className="flex flex-col h-full">
            {/* Header — search + new */}
            <div className="px-4 pt-4 pb-3 border-b border-border/40">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-foreground/90">Sessões</h2>
                    <button
                        type="button"
                        disabled
                        title="Nova execução (em 5b.2)"
                        className="text-[11px] text-muted-foreground/60 px-2 py-1 rounded border border-border/40 inline-flex items-center gap-1 cursor-not-allowed"
                    >
                        <Plus className="w-3 h-3" />
                        Nova
                    </button>
                </div>
                <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Buscar título ou ID…"
                        className="w-full bg-background/40 border border-border/40 rounded pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/50"
                    />
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-2 py-3">
                {loading && items.length === 0 ? (
                    <SidebarSkeleton />
                ) : filtered.length === 0 ? (
                    <div className="px-2 py-8 text-center text-xs text-muted-foreground/70">
                        {search ? 'Nada encontrado para essa busca.' : 'Nenhuma execução ainda.'}
                    </div>
                ) : (
                    Object.entries(grouped).map(([groupName, groupItems]) =>
                        groupItems.length === 0 ? null : (
                            <div key={groupName} className="mb-4">
                                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">
                                    {groupName}{' '}
                                    <span className="text-muted-foreground/40">
                                        ({groupItems.length})
                                    </span>
                                </div>
                                <div className="space-y-0.5">
                                    {groupItems.slice(0, 30).map(item => (
                                        <SessionCard
                                            key={item.id}
                                            item={item}
                                            active={activeId === item.id}
                                        />
                                    ))}
                                </div>
                            </div>
                        )
                    )
                )}
            </div>
        </div>
    );
}

function SessionCard({
    item,
    active,
}: {
    item: RuntimeWorkItemSummary;
    active: boolean;
}) {
    return (
        <Link
            href={`/execucoes/${item.id}`}
            className={cn(
                'block rounded px-2 py-2 transition-colors border-l-2',
                active
                    ? 'bg-primary/10 border-primary'
                    : 'border-transparent hover:bg-card/40',
            )}
        >
            <div className="flex items-start gap-2">
                <StatusBadge status={item.status} compact className="mt-1" />
                <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground/90 truncate" title={item.title}>
                        {item.title.replace(/^Delegated:\s*/, '')}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <RuntimeBadge slug={item.runtime_profile_slug} compact />
                        <span className="text-[10px] text-muted-foreground/70">
                            {relativeTime(item.created_at)}
                        </span>
                    </div>
                </div>
            </div>
        </Link>
    );
}

function SidebarSkeleton() {
    return (
        <div className="space-y-3 px-2 pt-2">
            {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="space-y-1.5 animate-pulse">
                    <div className="h-3 bg-card/60 rounded w-3/4" />
                    <div className="h-2 bg-card/40 rounded w-1/3" />
                </div>
            ))}
        </div>
    );
}

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'awaiting_approval']);

function groupByRecency(items: RuntimeWorkItemSummary[]): Record<string, RuntimeWorkItemSummary[]> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const groups: Record<string, RuntimeWorkItemSummary[]> = {
        'Ativas': [],
        'Hoje': [],
        'Ontem': [],
        'Esta semana': [],
        'Anteriores': [],
    };
    for (const item of items) {
        if (ACTIVE_STATUSES.has(item.status)) {
            groups['Ativas'].push(item);
            continue;
        }
        const diff = now - new Date(item.created_at).getTime();
        if (diff < day) groups['Hoje'].push(item);
        else if (diff < 2 * day) groups['Ontem'].push(item);
        else if (diff < 7 * day) groups['Esta semana'].push(item);
        else groups['Anteriores'].push(item);
    }
    return groups;
}

function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'agora';
    if (min < 60) return `${min}min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
