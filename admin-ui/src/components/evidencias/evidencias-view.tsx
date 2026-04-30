'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    MessageSquare, ServerCog, Beaker, Search, Loader2,
} from 'lucide-react';
import { useRuntimeClient } from '@/hooks/execucoes/use-runtime-client';
import { useWorkItems } from '@/hooks/execucoes/use-work-items';
import { WorkItemCard } from '@/components/execucoes/work-item-card';
import { RunnersHealthBar } from '@/components/execucoes/runners-health-bar';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';

// 6c.B.2 — DNA Claude Desktop:
//   - header serif para o título primário
//   - sub-abas pílula com counter à direita
//   - hover sutil bg-white/[0.03] (não bg-white/10 que é forte demais)
//   - rounded-lg generoso (10px+)
//   - filtros bar separada com bg #0E1218 (panel)

type SourceTab = 'chat' | 'direct' | 'test';

const TABS: Array<{
    id: SourceTab;
    label: string;
    description: string;
    icon: typeof MessageSquare;
    apiSource: 'chat' | 'admin' | 'test';
}> = [
    {
        id: 'chat',
        label: 'Chat & Code',
        description: 'Conversas com Modo Code originadas no /chat',
        icon: MessageSquare,
        apiSource: 'chat',
    },
    {
        id: 'direct',
        label: 'Execuções Diretas',
        description: 'Execuções via API SDK ou painel administrativo',
        icon: ServerCog,
        apiSource: 'admin',
    },
    {
        id: 'test',
        label: 'Reality-checks',
        description: 'Testes automatizados de regressão',
        icon: Beaker,
        apiSource: 'test',
    },
];

const STATUS_OPTIONS = [
    { value: '',           label: 'Todos os status' },
    { value: 'in_progress', label: 'Em andamento' },
    { value: 'pending',    label: 'Aguardando' },
    { value: 'done',       label: 'Concluídas' },
    { value: 'failed',     label: 'Falharam' },
    { value: 'cancelled',  label: 'Canceladas' },
];

const RUNTIME_OPTIONS = [
    { value: '',                      label: 'Todos os motores' },
    { value: 'claude_code_official',  label: 'Claude Code' },
    { value: 'openclaude',            label: 'OpenClaude' },
    { value: 'aider',                 label: 'Aider' },
];

export function EvidenciasView() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const tabFromUrl = (searchParams.get('tab') as SourceTab) ?? 'chat';
    const validTab: SourceTab = TABS.find(t => t.id === tabFromUrl)?.id ?? 'chat';
    const [tab, setTab] = useState<SourceTab>(validTab);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [runtimeFilter, setRuntimeFilter] = useState('');

    // Debounce search 250ms — evita request por keystroke.
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
        return () => clearTimeout(t);
    }, [search]);

    const apiSource = useMemo(
        () => TABS.find(t => t.id === tab)!.apiSource,
        [tab],
    );

    const client = useRuntimeClient();
    const filters = useMemo(() => ({
        parent_work_item_id: null as string | null,
        source: apiSource,
        ...(debouncedSearch ? { q: debouncedSearch } : {}),
        ...(statusFilter ? { status: [statusFilter] } : {}),
        ...(runtimeFilter ? { runtime_profile_slug: runtimeFilter } : {}),
        limit: 50,
    }), [apiSource, debouncedSearch, statusFilter, runtimeFilter]);

    const { items, loading, total, countsBySource } = useWorkItems(client, filters);

    function changeTab(next: SourceTab) {
        setTab(next);
        // preserva search params (ex: filtros) só trocando o tab
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', next);
        router.replace(`/evidencias?${params.toString()}`, { scroll: false });
    }

    return (
        <div className="max-w-5xl mx-auto w-full flex flex-col min-h-0">
            {/* Header — DNA Claude Desktop */}
            <div className="mb-4 flex-shrink-0 flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="text-2xl font-serif text-foreground/95 leading-tight">
                        Evidências
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Trilha de auditoria das interações governadas pela plataforma.
                    </p>
                </div>
                <div className="flex-shrink-0 hidden md:block">
                    <RunnersHealthBar />
                </div>
            </div>

            {/* Sub-tabs */}
            <div className="flex items-center gap-1 border-b border-border/40 mb-4 flex-shrink-0">
                {TABS.map(t => {
                    const Icon = t.icon;
                    const count = countsBySource[t.apiSource] ?? 0;
                    const isActive = tab === t.id;
                    return (
                        <button
                            key={t.id}
                            onClick={() => changeTab(t.id)}
                            className={cn(
                                'flex items-center gap-2 px-4 py-2.5 text-sm rounded-t-lg',
                                'transition-colors border-b-2 -mb-[2px]',
                                isActive
                                    ? 'text-foreground border-emerald-400 bg-white/[0.03]'
                                    : 'text-muted-foreground border-transparent hover:text-foreground/90 hover:bg-white/[0.02]',
                            )}
                            title={t.description}
                            aria-pressed={isActive}
                        >
                            <Icon className="w-4 h-4" />
                            <span className="font-medium">{t.label}</span>
                            <span className={cn(
                                'text-[11px] px-1.5 py-0.5 rounded-md font-mono',
                                isActive
                                    ? 'bg-emerald-500/15 text-emerald-300'
                                    : 'bg-white/5 text-muted-foreground',
                            )}>
                                {count}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Filters bar */}
            <div className="flex items-center gap-2 flex-wrap mb-4 flex-shrink-0">
                <div className="relative flex-1 min-w-[240px] max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/70" />
                    <input
                        type="text"
                        placeholder="Buscar por título…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 bg-card/40 border border-border/40 rounded-lg
                                   text-sm text-foreground/95 placeholder:text-muted-foreground/70
                                   focus:outline-none focus:border-emerald-400/40
                                   transition-colors"
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="bg-card/40 border border-border/40 rounded-lg text-xs px-3 py-2
                               text-foreground/90 focus:outline-none focus:ring-1 focus:ring-emerald-400/40"
                    aria-label="Filtrar por status"
                >
                    {STATUS_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <select
                    value={runtimeFilter}
                    onChange={e => setRuntimeFilter(e.target.value)}
                    className="bg-card/40 border border-border/40 rounded-lg text-xs px-3 py-2
                               text-foreground/90 focus:outline-none focus:ring-1 focus:ring-emerald-400/40"
                    aria-label="Filtrar por runtime"
                >
                    {RUNTIME_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                {total !== null && (
                    <span className="text-[11px] text-muted-foreground/70 ml-auto">
                        {total} {total === 1 ? 'resultado' : 'resultados'}
                    </span>
                )}
            </div>

            {/* List */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                {loading && items.length === 0 ? (
                    <ListSkeleton />
                ) : items.length === 0 ? (
                    <EmptyTabState tab={tab} hasFilters={Boolean(debouncedSearch || statusFilter || runtimeFilter)} />
                ) : (
                    <div className="space-y-2 pb-4">
                        {items.map(item => (
                            <WorkItemCard key={item.id} item={item} basePath="/evidencias" />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function EmptyTabState({ tab, hasFilters }: { tab: SourceTab; hasFilters: boolean }) {
    const t = TABS.find(x => x.id === tab)!;
    const Icon = t.icon;
    if (hasFilters) {
        return (
            <EmptyState
                icon={<Search className="w-6 h-6" />}
                title="Nenhum resultado"
                description="Tente afrouxar os filtros — busca, status ou motor."
            />
        );
    }
    return (
        <EmptyState
            icon={<Icon className="w-6 h-6" />}
            title={`Nenhuma ${t.label.toLowerCase()} ainda`}
            description={t.description}
            action={tab === 'direct' ? (
                <div className="flex items-center gap-2">
                    <a
                        href="/execucoes/nova"
                        className="text-xs font-medium px-3 py-1.5 rounded-md bg-violet-500 hover:bg-violet-600 text-white transition-colors"
                    >
                        Modo Agente
                    </a>
                    <a
                        href="/execucoes/livre"
                        className="text-xs font-medium px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white transition-colors"
                    >
                        Modo Livre
                    </a>
                </div>
            ) : tab === 'chat' ? (
                <a
                    href="/chat"
                    className="text-xs font-medium px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white transition-colors"
                >
                    Abrir Chat
                </a>
            ) : undefined}
        />
    );
}

function ListSkeleton() {
    return (
        <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map(i => (
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
            <div className="flex items-center justify-center pt-2 text-[11px] text-muted-foreground/60">
                <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> Carregando evidências…
            </div>
        </div>
    );
}
