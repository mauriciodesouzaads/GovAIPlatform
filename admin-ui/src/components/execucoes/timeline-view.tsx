'use client';

import { useState, useMemo } from 'react';
import {
    Play, Wrench, CheckCircle2, XCircle, AlertCircle, FileEdit,
    GitBranch, Brain, ChevronRight, ChevronDown,
} from 'lucide-react';
import type { RuntimeWorkItemEvent } from '@/types/runtime-admin';
import type { ViewMode } from './view-mode-toggle';
import { cn } from '@/lib/utils';

/**
 * Renders the event timeline for a single work_item.
 *
 * Three view modes (configured by the parent):
 *
 *   verbose: every event, raw seq order. Useful for debugging and
 *            audit replay.
 *
 *   normal (default): hides THINKING (often noisy) and FILE_CHANGED
 *            (usually 1-3 events per tool invocation already covered
 *            by the corresponding TOOL_RESULT). Tool calls render as
 *            paired START / RESULT to feel like a transcript.
 *
 *   summary: only RUN_STARTED, RUN_COMPLETED, RUN_FAILED, and a
 *            single aggregate "X tools used" line. Useful for a
 *            quick "what happened" glance.
 *
 * The component is kept presentational — no fetch, no SSE, no state
 * other than per-event "expanded?" toggles.
 */
export function TimelineView({
    events,
    mode,
}: {
    events: RuntimeWorkItemEvent[];
    mode: ViewMode;
}) {
    const visible = useMemo(() => filterEvents(events, mode), [events, mode]);

    if (visible.length === 0) {
        return (
            <div className="text-sm text-muted-foreground italic py-8 text-center">
                Nenhum evento no modo selecionado.
            </div>
        );
    }

    if (mode === 'summary') {
        return <TimelineSummary events={events} />;
    }

    // Pair TOOL_START with its TOOL_RESULT in normal mode so they
    // render as a single collapsible block.
    const rendered: React.ReactNode[] = [];
    const pairedResults = new Set<string>();

    if (mode === 'normal') {
        for (let i = 0; i < visible.length; i++) {
            const ev = visible[i];
            if (ev.type === 'TOOL_START') {
                const useId = (ev.payload?.toolUseId as string) || (ev.payload?.tool_use_id as string);
                const resultIdx = visible.findIndex((other, j) =>
                    j > i &&
                    other.type === 'TOOL_RESULT' &&
                    ((other.payload?.toolUseId as string) === useId ||
                     (other.payload?.tool_use_id as string) === useId),
                );
                if (resultIdx > 0) {
                    const result = visible[resultIdx];
                    pairedResults.add(result.id);
                    rendered.push(<ToolPairRow key={ev.id} start={ev} result={result} />);
                    continue;
                }
            }
            if (ev.type === 'TOOL_RESULT' && pairedResults.has(ev.id)) continue;
            rendered.push(<EventRow key={ev.id} event={ev} />);
        }
    } else {
        for (const ev of visible) rendered.push(<EventRow key={ev.id} event={ev} />);
    }

    return <ol className="space-y-2">{rendered}</ol>;
}

// ── Filter ─────────────────────────────────────────────────────────────────

function filterEvents(events: RuntimeWorkItemEvent[], mode: ViewMode): RuntimeWorkItemEvent[] {
    if (mode === 'verbose') return events;
    if (mode === 'summary') {
        return events.filter(e =>
            e.type === 'RUN_STARTED' ||
            e.type === 'RUN_COMPLETED' ||
            e.type === 'RUN_FAILED' ||
            e.type === 'SUBAGENT_SPAWN'
        );
    }
    // normal: hide THINKING + FILE_CHANGED
    return events.filter(e => e.type !== 'THINKING' && e.type !== 'FILE_CHANGED');
}

// ── Per-row renderers ──────────────────────────────────────────────────────

function EventRow({ event }: { event: RuntimeWorkItemEvent }) {
    switch (event.type) {
        case 'RUN_STARTED':       return <RunStartedRow event={event} />;
        case 'RUN_COMPLETED':     return <RunCompletedRow event={event} success />;
        case 'RUN_FAILED':        return <RunCompletedRow event={event} success={false} />;
        case 'TOOL_START':        return <ToolStartRow event={event} />;
        case 'TOOL_RESULT':       return <ToolResultRow event={event} />;
        case 'THINKING':          return <ThinkingRow event={event} />;
        case 'FILE_CHANGED':      return <FileChangedRow event={event} />;
        case 'SUBAGENT_SPAWN':    return <SubagentSpawnRow event={event} />;
        case 'SUBAGENT_COMPLETE': return <SubagentCompleteRow event={event} />;
        case 'ACTION_REQUIRED':   return <ActionRequiredRow event={event} />;
        case 'ACTION_RESPONSE':   return <ActionResponseRow event={event} />;
        default: return <GenericRow event={event} />;
    }
}

function RowFrame({
    icon, color, title, subtitle, time, children, ariaLabel,
}: {
    icon: React.ReactNode;
    color: string;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    time: string;
    children?: React.ReactNode;
    ariaLabel?: string;
}) {
    return (
        <li className="flex gap-3" aria-label={ariaLabel}>
            <span className={cn('mt-0.5 shrink-0', color)}>{icon}</span>
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground/90">{title}</span>
                    {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
                    <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto">
                        {fmtTime(time)}
                    </span>
                </div>
                {children}
            </div>
        </li>
    );
}

function RunStartedRow({ event }: { event: RuntimeWorkItemEvent }) {
    const title = (event.payload?.title as string) || 'Execução iniciada';
    const runtime = (event.payload?.runtimeProfile as string) || '';
    return (
        <RowFrame
            icon={<Play className="w-3.5 h-3.5" />}
            color="text-sky-400"
            title="Execução iniciada"
            subtitle={runtime}
            time={event.timestamp}
        >
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{title}</div>
        </RowFrame>
    );
}

function RunCompletedRow({ event, success }: { event: RuntimeWorkItemEvent; success: boolean }) {
    const tokens = event.payload?.tokens as { prompt?: number; completion?: number } | undefined;
    const error = event.payload?.error as string | undefined;
    return (
        <RowFrame
            icon={success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            color={success ? 'text-emerald-400' : 'text-rose-400'}
            title={success ? 'Execução concluída' : 'Execução falhou'}
            time={event.timestamp}
        >
            {tokens && (tokens.prompt || tokens.completion) ? (
                <div className="text-[11px] font-mono text-muted-foreground mt-0.5">
                    in {tokens.prompt ?? 0} · out {tokens.completion ?? 0}
                </div>
            ) : null}
            {error && (
                <div className="text-[11px] text-rose-300 mt-1 line-clamp-2">{error}</div>
            )}
        </RowFrame>
    );
}

function ToolStartRow({ event }: { event: RuntimeWorkItemEvent }) {
    const [open, setOpen] = useState(false);
    const args = event.payload?.args as string | undefined;
    return (
        <RowFrame
            icon={<Wrench className="w-3.5 h-3.5" />}
            color="text-amber-300"
            title="Ferramenta invocada"
            subtitle={event.tool_name || ''}
            time={event.timestamp}
        >
            {args && (
                <button
                    onClick={() => setOpen(o => !o)}
                    className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mt-0.5"
                >
                    {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    Argumentos
                </button>
            )}
            {open && args && (
                <pre className="mt-1 text-[11px] font-mono bg-card/40 border border-border/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {prettyJson(args)}
                </pre>
            )}
        </RowFrame>
    );
}

function ToolResultRow({ event }: { event: RuntimeWorkItemEvent }) {
    const [open, setOpen] = useState(false);
    const output = event.payload?.output as string | null | undefined;
    const isError = Boolean(event.payload?.isError);
    const preview = (output || '').replace(/\s+/g, ' ').trim();
    return (
        <RowFrame
            icon={<ChevronRight className="w-3.5 h-3.5" />}
            color={isError ? 'text-rose-400' : 'text-emerald-400'}
            title={isError ? 'Resultado (erro)' : 'Resultado'}
            subtitle={event.tool_name || ''}
            time={event.timestamp}
        >
            {preview && (
                <button
                    onClick={() => setOpen(o => !o)}
                    className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mt-0.5 max-w-full"
                >
                    {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    <span className="truncate">{open ? 'Esconder' : truncate(preview, 80)}</span>
                </button>
            )}
            {open && output && (
                <pre className="mt-1 text-[11px] font-mono bg-card/40 border border-border/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                    {output}
                </pre>
            )}
        </RowFrame>
    );
}

function ToolPairRow({
    start,
    result,
}: {
    start: RuntimeWorkItemEvent;
    result: RuntimeWorkItemEvent;
}) {
    return (
        <li className="rounded border border-border/40 bg-card/20 p-2">
            <ol className="space-y-1">
                <ToolStartRow event={start} />
                <ToolResultRow event={result} />
            </ol>
        </li>
    );
}

function ThinkingRow({ event }: { event: RuntimeWorkItemEvent }) {
    const [open, setOpen] = useState(false);
    const text = (event.payload?.text as string) || '';
    const truncated = event.payload?.truncated as boolean | undefined;
    return (
        <RowFrame
            icon={<Brain className="w-3.5 h-3.5" />}
            color="text-violet-400"
            title="Pensando"
            time={event.timestamp}
        >
            <div
                className={cn(
                    'text-xs italic text-muted-foreground/90 border-l-2 border-violet-500/30 pl-2 mt-0.5',
                    open ? '' : 'line-clamp-2',
                )}
            >
                {text || '(vazio)'}
            </div>
            {(text.length > 160 || truncated) && (
                <button
                    onClick={() => setOpen(o => !o)}
                    className="text-[10px] text-muted-foreground hover:text-foreground mt-0.5"
                >
                    {open ? '— recolher' : '— expandir'}
                </button>
            )}
        </RowFrame>
    );
}

function FileChangedRow({ event }: { event: RuntimeWorkItemEvent }) {
    const ev = event.payload?.event as string | undefined;
    const path = event.payload?.path as string | undefined;
    return (
        <RowFrame
            icon={<FileEdit className="w-3.5 h-3.5" />}
            color="text-cyan-400"
            title={`Arquivo: ${ev ?? 'change'}`}
            time={event.timestamp}
        >
            <code className="text-[11px] font-mono text-muted-foreground">{path}</code>
        </RowFrame>
    );
}

function SubagentSpawnRow({ event }: { event: RuntimeWorkItemEvent }) {
    const childId = event.payload?.child_work_item_id as string | undefined;
    const subType = event.payload?.subagent_type as string | undefined;
    const desc = event.payload?.description as string | undefined;
    return (
        <RowFrame
            icon={<GitBranch className="w-3.5 h-3.5" />}
            color="text-fuchsia-400"
            title="Subagente despachado"
            subtitle={subType}
            time={event.timestamp}
        >
            {desc && <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>}
            {childId && (
                <a
                    href={`/execucoes/${childId}`}
                    className="text-[11px] text-primary hover:underline mt-0.5 inline-block font-mono"
                >
                    abrir filho ↗
                </a>
            )}
        </RowFrame>
    );
}

function SubagentCompleteRow({ event }: { event: RuntimeWorkItemEvent }) {
    const isError = Boolean(event.payload?.is_error);
    const excerpt = event.payload?.result_excerpt as string | undefined;
    return (
        <RowFrame
            icon={<GitBranch className="w-3.5 h-3.5" />}
            color={isError ? 'text-rose-400' : 'text-fuchsia-300'}
            title={isError ? 'Subagente falhou' : 'Subagente concluído'}
            time={event.timestamp}
        >
            {excerpt && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{excerpt}</div>}
        </RowFrame>
    );
}

function ActionRequiredRow({ event }: { event: RuntimeWorkItemEvent }) {
    const question = (event.payload?.question as string) || 'Aprovação necessária';
    return (
        <RowFrame
            icon={<AlertCircle className="w-3.5 h-3.5" />}
            color="text-amber-400"
            title="Aguardando ação humana"
            time={event.timestamp}
        >
            <div className="text-xs text-muted-foreground italic mt-0.5">"{question}"</div>
        </RowFrame>
    );
}

function ActionResponseRow({ event }: { event: RuntimeWorkItemEvent }) {
    const approved = Boolean(event.payload?.approved);
    return (
        <RowFrame
            icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            color={approved ? 'text-emerald-400' : 'text-slate-400'}
            title={approved ? 'Ação aprovada' : 'Ação negada'}
            time={event.timestamp}
        />
    );
}

function GenericRow({ event }: { event: RuntimeWorkItemEvent }) {
    return (
        <RowFrame
            icon={<ChevronRight className="w-3.5 h-3.5" />}
            color="text-muted-foreground"
            title={event.type}
            time={event.timestamp}
        />
    );
}

// ── Summary ────────────────────────────────────────────────────────────────

function TimelineSummary({ events }: { events: RuntimeWorkItemEvent[] }) {
    const start = events.find(e => e.type === 'RUN_STARTED');
    const end = events.find(e => e.type === 'RUN_COMPLETED' || e.type === 'RUN_FAILED');
    const toolCount = events.filter(e => e.type === 'TOOL_START').length;
    const subagentCount = events.filter(e => e.type === 'SUBAGENT_SPAWN').length;

    return (
        <ol className="space-y-2">
            {start && <EventRow event={start} />}
            {(toolCount > 0 || subagentCount > 0) && (
                <li className="flex gap-3 text-sm text-muted-foreground">
                    <span className="mt-0.5 shrink-0 text-amber-300">
                        <Wrench className="w-3.5 h-3.5" />
                    </span>
                    <div>
                        {toolCount} ferramenta{toolCount === 1 ? '' : 's'} usada{toolCount === 1 ? '' : 's'}
                        {subagentCount > 0 && ` · ${subagentCount} subagente${subagentCount === 1 ? '' : 's'}`}
                    </div>
                </li>
            )}
            {end && <EventRow event={end} />}
        </ol>
    );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
    try {
        return new Date(iso).toLocaleTimeString('pt-BR', { hour12: false });
    } catch {
        return iso;
    }
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function prettyJson(s: string): string {
    try {
        return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
        return s;
    }
}
