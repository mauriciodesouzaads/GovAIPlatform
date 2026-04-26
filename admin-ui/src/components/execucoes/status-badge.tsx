'use client';

import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<string, {
    label: string;
    pill: string;
    dot: string;
}> = {
    pending: {
        label: 'Aguardando',
        pill: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
        dot: 'bg-amber-400',
    },
    in_progress: {
        label: 'Em andamento',
        pill: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
        dot: 'bg-sky-400 animate-pulse',
    },
    awaiting_approval: {
        label: 'Aguarda aprovação',
        pill: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
        dot: 'bg-violet-400',
    },
    done: {
        label: 'Concluída',
        pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
        dot: 'bg-emerald-400',
    },
    failed: {
        label: 'Falhou',
        pill: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
        dot: 'bg-rose-400',
    },
    blocked: {
        label: 'Bloqueada',
        pill: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
        dot: 'bg-rose-400',
    },
    cancelled: {
        label: 'Cancelada',
        pill: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
        dot: 'bg-slate-400',
    },
};

export function StatusBadge({
    status,
    compact,
    className,
}: {
    status: string;
    compact?: boolean;
    className?: string;
}) {
    const cfg = STATUS_STYLES[status] || STATUS_STYLES.pending;
    if (compact) {
        return (
            <span
                className={cn('inline-block w-2 h-2 rounded-full shrink-0', cfg.dot, className)}
                title={cfg.label}
                aria-label={cfg.label}
            />
        );
    }
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded border',
                cfg.pill,
                className,
            )}
        >
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', cfg.dot)} />
            {cfg.label}
        </span>
    );
}

export function statusLabel(status: string): string {
    return STATUS_STYLES[status]?.label ?? status;
}
