'use client';

import { useRunnersHealth } from '@/hooks/execucoes/use-runners-health';
import { useRuntimeClient } from '@/hooks/execucoes/use-runtime-client';
import { cn } from '@/lib/utils';

const SHORT_NAMES: Record<string, string> = {
    claude_code_official: 'Claude Code',
    openclaude: 'OpenClaude',
    aider: 'Aider',
};

/**
 * Compact horizontal strip with one dot per runner. Hover tooltip
 * exposes transport (unix/tcp), socket path, and grpc host. Sits on
 * the page header so the operator sees runner availability without
 * navigating to a separate diagnostics screen.
 */
export function RunnersHealthBar({ className }: { className?: string }) {
    const client = useRuntimeClient();
    const { runners, loading } = useRunnersHealth(client);

    if (loading && runners.length === 0) {
        return (
            <div className={cn('text-[11px] text-muted-foreground/60', className)}>
                Verificando runners…
            </div>
        );
    }

    if (runners.length === 0) {
        return (
            <div className={cn('text-[11px] text-muted-foreground/60', className)}>
                Sem runners configurados
            </div>
        );
    }

    return (
        <div className={cn('flex items-center gap-3', className)}>
            {runners.map(r => {
                const tooltip = [
                    SHORT_NAMES[r.slug] ?? r.slug,
                    r.transport,
                    r.available ? 'online' : 'offline',
                    r.socket_path ? `socket=${r.socket_path}` : `host=${r.grpc_host ?? '?'}`,
                ].join(' · ');
                return (
                    <div
                        key={r.slug}
                        className="flex items-center gap-1.5 text-[11px]"
                        title={tooltip}
                    >
                        <span
                            className={cn(
                                'w-1.5 h-1.5 rounded-full shrink-0',
                                r.available ? 'bg-emerald-400' : 'bg-rose-400',
                            )}
                            aria-label={r.available ? 'online' : 'offline'}
                        />
                        <span className="text-muted-foreground">
                            {SHORT_NAMES[r.slug] ?? r.slug}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
