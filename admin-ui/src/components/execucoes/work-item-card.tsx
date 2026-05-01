'use client';

import Link from 'next/link';
import { Wrench, Activity, AlertTriangle } from 'lucide-react';
import type { RuntimeWorkItemSummary } from '@/types/runtime-admin';
import { StatusBadge } from './status-badge';
import { RuntimeBadge } from './runtime-badge';
import { cn } from '@/lib/utils';

/**
 * One row in the main /execucoes list. Click → opens detail page.
 *
 * Layout: status pill | title | runtime badge | tool count |
 *         tokens (if any) | error indicator | created_at
 */
export function WorkItemCard({
    item,
    basePath = '/execucoes',  // 6c.B.2 — overridable p/ /evidencias usar mesmo card
}: {
    item: RuntimeWorkItemSummary;
    basePath?: string;
}) {
    const cleanTitle = item.title.replace(/^Delegated:\s*/, '');
    return (
        <Link
            href={`${basePath}/${item.id}`}
            className={cn(
                'block bg-card/30 border border-border/40 rounded-lg px-4 py-3',
                'hover:border-primary/30 hover:bg-card/60 transition-colors',
                item.has_error && 'border-danger-border',
            )}
        >
            <div className="flex items-center gap-3 flex-wrap">
                <StatusBadge status={item.status} />

                <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground/90 truncate" title={cleanTitle}>
                        {cleanTitle}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <RuntimeBadge slug={item.runtime_profile_slug} compact />
                        {item.subagent_depth > 0 && (
                            <span className="text-[10px] font-mono text-fuchsia-400/80">
                                subagente d{item.subagent_depth}
                            </span>
                        )}
                        <span className="text-[10px] font-mono text-muted-foreground/60">
                            {item.id.slice(0, 8)}
                        </span>
                    </div>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground/80 shrink-0">
                    {item.tool_count > 0 && (
                        <span className="inline-flex items-center gap-1" title={`${item.tool_count} ferramentas`}>
                            <Wrench className="w-3 h-3" />
                            {item.tool_count}
                        </span>
                    )}
                    {item.tokens && (item.tokens.prompt + item.tokens.completion > 0) && (
                        <span className="font-mono" title="Tokens">
                            {item.tokens.prompt}+{item.tokens.completion}
                        </span>
                    )}
                    {item.has_error && (
                        <AlertTriangle className="w-3.5 h-3.5 text-danger-fg" />
                    )}
                    {(item.status === 'in_progress' || item.status === 'pending') && (
                        <Activity className="w-3 h-3 text-info-fg animate-pulse" />
                    )}
                </div>

                <div className="text-[11px] text-muted-foreground/70 font-mono shrink-0 w-20 text-right">
                    {fmtDate(item.created_at)}
                </div>
            </div>
        </Link>
    );
}

function fmtDate(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
