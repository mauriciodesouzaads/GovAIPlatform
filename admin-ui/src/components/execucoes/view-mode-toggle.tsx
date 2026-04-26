'use client';

import { Eye, EyeOff, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ViewMode = 'verbose' | 'normal' | 'summary';

const MODES: { value: ViewMode; label: string; icon: React.ReactNode; hint: string }[] = [
    { value: 'verbose', label: 'Verbose', icon: <Eye className="w-3 h-3" />, hint: 'Todos os eventos, incluindo pensamento e mudanças de arquivo' },
    { value: 'normal',  label: 'Normal',  icon: <EyeOff className="w-3 h-3" />, hint: 'Início, ferramentas, resultado e fim — esconde pensamento e file watch' },
    { value: 'summary', label: 'Resumo',  icon: <Minimize2 className="w-3 h-3" />, hint: 'Apenas marcos: início, contagem de ferramentas, fim' },
];

export function ViewModeToggle({
    value,
    onChange,
    className,
}: {
    value: ViewMode;
    onChange: (v: ViewMode) => void;
    className?: string;
}) {
    return (
        <div
            className={cn(
                'inline-flex items-center gap-0.5 p-0.5 bg-card/40 border border-border/40 rounded',
                className,
            )}
            role="tablist"
            aria-label="Modo de visualização"
        >
            {MODES.map(m => (
                <button
                    key={m.value}
                    onClick={() => onChange(m.value)}
                    title={m.hint}
                    role="tab"
                    aria-selected={value === m.value}
                    className={cn(
                        'flex items-center gap-1.5 text-[11px] px-2 py-1 rounded transition-colors',
                        value === m.value
                            ? 'bg-primary/15 text-primary'
                            : 'text-muted-foreground hover:text-foreground',
                    )}
                >
                    {m.icon}
                    <span>{m.label}</span>
                </button>
            ))}
        </div>
    );
}
