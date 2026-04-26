'use client';

import { cn } from '@/lib/utils';

const RUNTIME_LABELS: Record<string, { short: string; long: string; icon: string }> = {
    claude_code_official: { short: 'Claude Code', long: 'Claude Code', icon: '🔒' },
    openclaude: { short: 'OpenClaude', long: 'OpenClaude (Open Runtime)', icon: '🌐' },
    aider: { short: 'Aider', long: 'Aider', icon: '🌐' },
};

export function RuntimeBadge({
    slug,
    compact,
    className,
}: {
    slug: string | null;
    compact?: boolean;
    className?: string;
}) {
    if (!slug) {
        return (
            <span className={cn('text-[10px] text-muted-foreground/60 font-mono', className)}>
                —
            </span>
        );
    }
    const cfg = RUNTIME_LABELS[slug] ?? { short: slug, long: slug, icon: '·' };
    if (compact) {
        return (
            <span
                className={cn(
                    'inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground',
                    className,
                )}
                title={cfg.long}
            >
                <span aria-hidden>{cfg.icon}</span>
                {cfg.short}
            </span>
        );
    }
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded border border-border/40 bg-card/40 text-muted-foreground',
                className,
            )}
            title={cfg.long}
        >
            <span aria-hidden>{cfg.icon}</span>
            {cfg.short}
        </span>
    );
}
