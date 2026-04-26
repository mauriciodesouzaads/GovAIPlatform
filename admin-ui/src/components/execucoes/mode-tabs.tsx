'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sparkles, FlaskConical } from 'lucide-react';

/**
 * Tab strip shared by /execucoes/nova and /execucoes/livre. Highlights
 * the active mode and uses Next.js Link prefetching so switching is
 * instant.
 */
export function ModeTabs() {
    const pathname = usePathname() ?? '';
    const tabs = [
        {
            href: '/execucoes/nova',
            label: 'Modo Agente',
            description: 'Pacote pré-configurado',
            icon: Sparkles,
            colorActive: 'border-violet-500/60 bg-violet-500/10 text-violet-200',
        },
        {
            href: '/execucoes/livre',
            label: 'Modo Livre',
            description: 'Harness inline',
            icon: FlaskConical,
            colorActive: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200',
        },
    ];

    return (
        <div className="flex gap-2 mb-6">
            {tabs.map(t => {
                const active = pathname === t.href || pathname.startsWith(t.href + '/');
                const Icon = t.icon;
                return (
                    <Link
                        key={t.href}
                        href={t.href}
                        className={[
                            'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                            active
                                ? t.colorActive
                                : 'border-border/40 bg-card/20 text-muted-foreground hover:bg-card/40',
                        ].join(' ')}
                    >
                        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                        <div className="text-left">
                            <div className="text-sm font-medium leading-tight">{t.label}</div>
                            <div className="text-[10px] opacity-80 leading-tight">{t.description}</div>
                        </div>
                    </Link>
                );
            })}
        </div>
    );
}
