'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useDebounce } from 'use-debounce';
import {
    Plus, Search, Pin, Archive, MoreVertical, Loader2,
    MessageSquare, ArrowLeft,
} from 'lucide-react';
import { useChatClient } from './use-chat-client';
import type { Conversation } from '@/lib/chat-client';

/**
 * Sidebar de conversas — agrupada por recência (Hoje / Ontem /
 * Esta semana / Anteriores), com busca debounced e botão "Nova
 * conversa". Espelha a UX da [Claude.ai](http://Claude.ai)/Claude Desktop.
 */
export function ChatSidebar() {
    const client = useChatClient();
    const router = useRouter();
    const params = useParams();
    const activeId = params?.id as string | undefined;

    const [items, setItems] = useState<Conversation[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchInput, setSearchInput] = useState('');
    const [search] = useDebounce(searchInput, 200);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        if (!client) return;
        let cancelled = false;
        const ctrl = new AbortController();
        (async () => {
            try {
                const list = await client.listConversations(
                    { archived: false, search: search || undefined, limit: 100 },
                    ctrl.signal,
                );
                if (!cancelled) setItems(list);
            } catch (e) {
                if ((e as Error).name === 'AbortError') return;
                if (!cancelled) console.error('[chat sidebar]', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; ctrl.abort(); };
    }, [client, search]);

    const grouped = useMemo(() => groupByRecency(items), [items]);

    async function newConversation() {
        if (!client || creating) return;
        setCreating(true);
        try {
            const conv = await client.createConversation();
            router.push(`/chat/${conv.id}`);
        } catch (e) {
            console.error('[chat sidebar] create failed', e);
        } finally {
            setCreating(false);
        }
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-3 pt-3 pb-2 border-b border-border-100">
                <div className="flex items-center justify-between mb-2">
                    <Link
                        href="/"
                        className="text-xs text-text-500 hover:text-text-100 inline-flex items-center gap-1 transition-colors"
                        title="Voltar ao painel"
                    >
                        <ArrowLeft className="w-3 h-3" />
                        GovAI
                    </Link>
                </div>
                <button
                    onClick={newConversation}
                    disabled={creating}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200 text-sm font-medium px-3 py-2 transition-colors disabled:opacity-50"
                >
                    {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    Nova conversa
                </button>
                <div className="relative mt-2">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-500" />
                    <input
                        type="text"
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                        placeholder="Buscar conversas…"
                        className="w-full bg-[#141820] border border-border-100 rounded-md pl-8 pr-3 py-1.5 text-xs text-text-100 placeholder:text-text-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                    />
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-2 py-2">
                {loading && items.length === 0 ? (
                    <SidebarSkeleton />
                ) : items.length === 0 ? (
                    <div className="px-2 py-12 text-center text-xs text-text-500">
                        {search
                            ? 'Nada encontrado.'
                            : 'Nenhuma conversa ainda. Comece uma nova.'}
                    </div>
                ) : (
                    Object.entries(grouped).map(([groupName, groupItems]) =>
                        groupItems.length === 0 ? null : (
                            <div key={groupName} className="mb-3">
                                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-500 font-medium">
                                    {groupName}
                                </div>
                                <div className="space-y-px">
                                    {groupItems.map(item => (
                                        <ConvCard
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

function ConvCard({ item, active }: { item: Conversation; active: boolean }) {
    // 6c.A.1 — quando conversation tem agente vinculado, mostrar avatar
    // emoji do agente em vez do icone genérico (Pin/MessageSquare).
    // Pinned ainda tem ícone próprio que se sobrepõe (decisão UX:
    // pin é estado, agente é identidade).
    const hasAgent = Boolean(item.assistant_id && item.assistant_avatar);
    return (
        <Link
            href={`/chat/${item.id}`}
            className={[
                'block rounded-md px-2 py-2 transition-colors text-xs',
                active
                    ? 'bg-emerald-500/10 text-emerald-100'
                    : 'text-text-100 hover:bg-bg-200',
            ].join(' ')}
        >
            <div className="flex items-start gap-2">
                {item.pinned ? (
                    <Pin className="w-3 h-3 text-emerald-400/80 flex-shrink-0 mt-0.5" />
                ) : hasAgent ? (
                    <span className="text-[14px] leading-none flex-shrink-0 mt-0.5" aria-hidden>
                        {item.assistant_avatar}
                    </span>
                ) : (
                    <MessageSquare className="w-3 h-3 text-text-500 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                    <div className="truncate text-[13px] leading-tight">
                        {item.title}
                    </div>
                    <div className="text-[10px] text-text-500 mt-0.5">
                        {relativeTime(item.last_message_at || item.created_at)}
                    </div>
                </div>
            </div>
        </Link>
    );
}

function SidebarSkeleton() {
    return (
        <div className="space-y-2 px-2 pt-2">
            {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="space-y-1.5 animate-pulse">
                    <div className="h-3 bg-bg-200 rounded w-3/4" />
                    <div className="h-2 bg-bg-200 rounded w-1/3" />
                </div>
            ))}
        </div>
    );
}

function groupByRecency(items: Conversation[]): Record<string, Conversation[]> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const groups: Record<string, Conversation[]> = {
        Fixadas: [],
        Hoje: [],
        Ontem: [],
        'Esta semana': [],
        Anteriores: [],
    };
    for (const item of items) {
        if (item.pinned) {
            groups.Fixadas.push(item);
            continue;
        }
        const ts = item.last_message_at ? new Date(item.last_message_at).getTime() : new Date(item.created_at).getTime();
        const diff = now - ts;
        if (diff < day) groups.Hoje.push(item);
        else if (diff < 2 * day) groups.Ontem.push(item);
        else if (diff < 7 * day) groups['Esta semana'].push(item);
        else groups.Anteriores.push(item);
    }
    return groups;
}

function relativeTime(iso: string | null): string {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'agora';
    if (min < 60) return `${min}min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
