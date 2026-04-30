'use client';

/**
 * FASE 14.0/6c.B.3 CP1 — Theme Toggle
 * ---------------------------------------------------------------------------
 * Segmented control com 3 opções (Sistema / Claro / Escuro), replicando o
 * padrão visual do Claude.ai exatamente. Ícones lucide-react: Monitor /
 * Sun / Moon, sem texto (label fica em sr-only + title).
 *
 * Visual:
 *   - Container compacto (inline-flex) com bg-bg-200 + border sutil
 *   - Botão ativo: bg-bg-0 + sombra leve + texto em text-text-0
 *   - Botão inativo: text-text-500 + hover sutil
 */

import { Monitor, Sun, Moon } from 'lucide-react';
import { useTheme, type ThemeMode } from '@/lib/theme';

const OPTIONS: Array<{
    value: ThemeMode;
    icon: typeof Monitor;
    label: string;
    title: string;
}> = [
    { value: 'system', icon: Monitor, label: 'Sistema', title: 'Usar tema do sistema operacional' },
    { value: 'light',  icon: Sun,     label: 'Claro',   title: 'Tema claro' },
    { value: 'dark',   icon: Moon,    label: 'Escuro',  title: 'Tema escuro' },
];

export function ThemeToggle({ size = 'md' }: { size?: 'sm' | 'md' }) {
    const { mode, setMode } = useTheme();
    const dims = size === 'sm'
        ? 'w-7 h-6 [&>svg]:w-3.5 [&>svg]:h-3.5'
        : 'w-9 h-7 [&>svg]:w-4 [&>svg]:h-4';

    return (
        <div
            role="radiogroup"
            aria-label="Aparência"
            className="inline-flex items-center gap-0.5 p-0.5 rounded-md
                       bg-bg-200 border border-border-200"
        >
            {OPTIONS.map(({ value, icon: Icon, label, title }) => {
                const active = mode === value;
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={title}
                        onClick={() => setMode(value)}
                        className={[
                            'flex items-center justify-center rounded',
                            dims,
                            'transition-colors duration-150',
                            active
                                ? 'bg-bg-0 text-text-0 shadow-sm border border-border-200'
                                : 'text-text-500 hover:text-text-200 hover:bg-bg-300 border border-transparent',
                        ].join(' ')}
                    >
                        <Icon strokeWidth={1.75} />
                        <span className="sr-only">{label}</span>
                    </button>
                );
            })}
        </div>
    );
}
