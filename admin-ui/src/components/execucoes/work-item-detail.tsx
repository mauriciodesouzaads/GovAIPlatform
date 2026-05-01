'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
    ChevronLeft, XCircle, Loader2, MessageSquare, ArrowUpRight,
} from 'lucide-react';
import { useRuntimeClient } from '@/hooks/execucoes/use-runtime-client';
import { useWorkItemDetail } from '@/hooks/execucoes/use-work-item-detail';
import { TimelineView } from './timeline-view';
import { ViewModeToggle, type ViewMode } from './view-mode-toggle';
import { StatusBadge } from './status-badge';
import { RuntimeBadge } from './runtime-badge';
import { cn } from '@/lib/utils';

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'awaiting_approval']);

/**
 * Right-side detail of a single work_item. Two columns inside:
 *
 *   metadata (~280px) | timeline + view-mode toggle
 *
 * The timeline auto-streams via SSE while the run is active; the
 * useWorkItemDetail hook handles connect/disconnect lifecycles.
 */
export function WorkItemDetail({
    id,
    listHref = '/execucoes',  // 6c.B.2 — /evidencias passa '/evidencias' p/ back-link consistente
}: {
    id: string;
    listHref?: string;
}) {
    const client = useRuntimeClient();
    const { detail, events, streaming, loading, error, refresh } = useWorkItemDetail(client, id);
    const [viewMode, setViewMode] = useState<ViewMode>('normal');
    const [cancelling, setCancelling] = useState(false);

    if (loading && !detail) {
        return (
            <div className="text-sm text-muted-foreground py-8 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Carregando…
            </div>
        );
    }

    if (error && !detail) {
        return (
            <div className="text-sm text-danger-fg py-8">
                Falha ao carregar: {error.message}
            </div>
        );
    }

    if (!detail) return null;

    const wi = detail.work_item;
    const canCancel = ACTIVE_STATUSES.has(wi.status);
    // 6c.B: quando o turn foi disparado pelo /chat (handleCodeTurn marcou
    // execution_context.source='chat'), mostramos um banner com link de
    // volta para a conversa. Permite ao usuário pular entre o panel
    // técnico e a conversa que originou a execução sem ter que navegar
    // pelo histórico.
    const ctx = wi.execution_context as Record<string, unknown> | null;
    const chatConversationId = ctx?.source === 'chat'
        ? (ctx.conversation_id as string | undefined)
        : undefined;

    async function onCancel() {
        if (!client) return;
        setCancelling(true);
        try {
            await client.cancelWorkItem(id);
            await refresh();
        } catch (err) {
            console.error('cancel failed', err);
        } finally {
            setCancelling(false);
        }
    }

    return (
        <div className="max-w-6xl mx-auto h-full flex flex-col min-h-0">
            {/* Top bar with back link + cancel */}
            <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <Link
                    href={listHref}
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                    <ChevronLeft className="w-3 h-3" /> Lista
                </Link>
                {canCancel && (
                    <button
                        onClick={onCancel}
                        disabled={cancelling}
                        className={cn(
                            'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border',
                            'border-danger-border text-danger-fg hover:bg-danger-bg transition-colors',
                            cancelling && 'opacity-50 cursor-not-allowed',
                        )}
                    >
                        <XCircle className="w-3 h-3" />
                        {cancelling ? 'Cancelando…' : 'Cancelar'}
                    </button>
                )}
            </div>

            {/* Title row */}
            <div className="mb-6 flex-shrink-0">
                <h2 className="text-lg font-semibold text-foreground/90 truncate" title={wi.title}>
                    {wi.title.replace(/^Delegated:\s*/, '')}
                </h2>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <StatusBadge status={wi.status} />
                    {streaming && (
                        <span className="text-[11px] text-success-fg inline-flex items-center gap-1">
                            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                            ao vivo
                        </span>
                    )}
                    <span className="text-[10px] font-mono text-muted-foreground/60">
                        {wi.id.slice(0, 8)}…{wi.id.slice(-4)}
                    </span>
                </div>
            </div>

            {/* 6c.B: Back-link banner para origens em /chat */}
            {chatConversationId && (
                <Link
                    href={`/chat/${chatConversationId}`}
                    className="mb-4 flex items-center gap-2 px-3 py-2 rounded-md border border-success-border bg-emerald-500/5 text-xs text-success-fg hover:bg-success-bg transition-colors flex-shrink-0"
                >
                    <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1">
                        Esta execução foi iniciada a partir de uma conversa no Chat.
                    </span>
                    <span className="inline-flex items-center gap-1 text-success-fg group-hover:underline">
                        Voltar à conversa
                        <ArrowUpRight className="w-3 h-3" />
                    </span>
                </Link>
            )}

            {/* Body — 2 cols */}
            <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 flex-1 min-h-0">
                {/* Metadata */}
                <aside className="space-y-4 lg:overflow-y-auto lg:pr-2">
                    <Field label="Runtime">
                        <RuntimeBadge slug={wi.runtime_profile_slug} />
                    </Field>

                    {wi.session_id && (
                        <Field label="Sessão CLI">
                            <code className="text-[11px] font-mono text-muted-foreground">
                                {wi.session_id.slice(0, 8)}…
                            </code>
                        </Field>
                    )}

                    {wi.parent_work_item_id && (
                        <Field label="Parent">
                            <Link
                                href={`/execucoes/${wi.parent_work_item_id}`}
                                className="text-xs text-primary hover:underline font-mono"
                            >
                                {wi.parent_work_item_id.slice(0, 8)}… ↑
                            </Link>
                        </Field>
                    )}

                    {wi.subagent_depth > 0 && (
                        <Field label="Profundidade">
                            <span className="text-xs text-fuchsia-400">
                                d{wi.subagent_depth}
                            </span>
                        </Field>
                    )}

                    {detail.subagents.length > 0 && (
                        <Field label={`Subagentes (${detail.subagents.length})`}>
                            <div className="space-y-1">
                                {detail.subagents.slice(0, 5).map(s => (
                                    <Link
                                        key={s.id}
                                        href={`/execucoes/${s.id}`}
                                        className="block text-[11px] text-primary hover:underline truncate"
                                    >
                                        {s.title.replace(/^Delegated:\s*/, '').slice(0, 40)}
                                    </Link>
                                ))}
                            </div>
                        </Field>
                    )}

                    <Field label="Ferramentas">
                        <span className="text-sm">{wi.tool_count}</span>
                    </Field>

                    <Field label="Eventos">
                        <span className="text-sm">{wi.event_count}</span>
                    </Field>

                    {wi.tokens && (wi.tokens.prompt + wi.tokens.completion > 0) && (
                        <Field label="Tokens">
                            <span className="text-[11px] font-mono text-muted-foreground">
                                in {wi.tokens.prompt} · out {wi.tokens.completion}
                            </span>
                        </Field>
                    )}

                    {wi.mcp_server_ids && wi.mcp_server_ids.length > 0 && (
                        <Field label={`MCP servers (${wi.mcp_server_ids.length})`}>
                            <div className="space-y-0.5">
                                {wi.mcp_server_ids.slice(0, 3).map(sid => (
                                    <code
                                        key={sid}
                                        className="block text-[10px] font-mono text-muted-foreground truncate"
                                    >
                                        {sid.slice(0, 8)}…
                                    </code>
                                ))}
                            </div>
                        </Field>
                    )}

                    <Field label="Iniciado">
                        <span className="text-[11px] text-muted-foreground">
                            {fmtDateTime(wi.created_at)}
                        </span>
                    </Field>

                    {wi.completed_at && (
                        <Field label="Concluído">
                            <span className="text-[11px] text-muted-foreground">
                                {fmtDateTime(wi.completed_at)}
                            </span>
                        </Field>
                    )}

                    {wi.dispatch_error && (
                        <Field label="Erro">
                            <pre className="text-[11px] text-danger-fg whitespace-pre-wrap break-all bg-rose-500/5 border border-danger-border rounded p-2 max-h-32 overflow-y-auto">
                                {wi.dispatch_error}
                            </pre>
                        </Field>
                    )}
                </aside>

                {/* Timeline */}
                <main className="flex flex-col min-h-0 min-w-0">
                    <div className="flex items-center justify-between mb-3 flex-shrink-0">
                        <h3 className="text-sm font-medium text-foreground/90">Timeline</h3>
                        <ViewModeToggle value={viewMode} onChange={setViewMode} />
                    </div>
                    <div className="flex-1 overflow-y-auto pr-2 min-h-0">
                        <TimelineView events={events} mode={viewMode} />
                    </div>
                </main>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium mb-1">
                {label}
            </div>
            <div>{children}</div>
        </div>
    );
}

function fmtDateTime(iso: string): string {
    try {
        return new Date(iso).toLocaleString('pt-BR', { hour12: false });
    } catch {
        return iso;
    }
}
