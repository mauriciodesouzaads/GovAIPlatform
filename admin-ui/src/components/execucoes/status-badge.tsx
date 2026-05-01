'use client';

import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<string, {
    label: string;
    pill: string;
    dot: string;
}> = {
    pending: {
        label: 'Aguardando',
        pill: 'bg-warning-bg text-warning-fg border-warning-border',
        dot: 'bg-amber-400',
    },
    in_progress: {
        label: 'Em andamento',
        pill: 'bg-info-bg text-info-fg border-info-border',
        dot: 'bg-sky-400 animate-pulse',
    },
    awaiting_approval: {
        label: 'Aguarda aprovação',
        pill: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
        dot: 'bg-violet-400',
    },
    done: {
        label: 'Concluída',
        pill: 'bg-success-bg text-success-fg border-success-border',
        dot: 'bg-emerald-400',
    },
    failed: {
        label: 'Falhou',
        pill: 'bg-danger-bg text-danger-fg border-danger-border',
        dot: 'bg-rose-400',
    },
    blocked: {
        label: 'Bloqueada',
        pill: 'bg-danger-bg text-danger-fg border-danger-border',
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
