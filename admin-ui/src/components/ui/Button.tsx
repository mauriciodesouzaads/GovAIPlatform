/**
 * GovAI Button Component — CTA Hierarchy (FASE 14.0/6c.B.3 CP1.D-C)
 * ---------------------------------------------------------------------------
 * Source of truth para hierarquia de botões da admin-ui. CP4 Polish Pass
 * migrará todos os botões dispersos para este componente — agora ele é
 * fonte da verdade e documentação.
 *
 * Variants:
 *   primary       (emerald)   — CTA principal governance: Salvar, Aprovar,
 *                               Confirmar, Nova Política, Novo Webhook
 *   primary-ai    (violet)    — CTA principal IA: Auto-avaliar, Vetorizar,
 *                               Nova Skill, Delegação
 *   inverse       (fg/bg)     — Destaque inverso (raro): "Criar Nova Versão"
 *   secondary     (bg-200)    — Alternative actions: Cancelar, Voltar
 *   ghost         (text)      — Lightweight: Close, Dismiss, link-like
 *   danger        (red)       — Destrutivo: Revogar, Deletar, Iniciar Rejeição
 *
 * Sizes:
 *   sm  (h-8)   — controles compactos
 *   md  (h-10)  — default p/ a maioria dos CTAs
 *   lg  (h-12)  — heros e ações principais
 *
 * Usage:
 *   <Button variant="primary" leftIcon={<Save className="w-4 h-4" />}>
 *     Salvar
 *   </Button>
 *
 *   <Button variant="primary-ai" size="sm" leftIcon={<Sparkles />}>
 *     Auto-avaliar
 *   </Button>
 *
 *   <Button variant="danger" leftIcon={<Trash2 />} onClick={onDelete}>
 *     Deletar
 *   </Button>
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ButtonVariant =
    | 'primary'         // emerald — governance CTAs
    | 'primary-ai'      // violet — AI feature CTAs
    | 'inverse'         // fg/bg — emphasized inverse
    | 'secondary'       // bg-200 + border — alternative
    | 'ghost'           // text-only com hover
    | 'danger';         // red — destructive

export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
    primary:      'bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/50',
    'primary-ai': 'bg-violet-500 text-white hover:bg-violet-500/90 disabled:bg-violet-500/50',
    inverse:      'bg-foreground text-background hover:bg-foreground/90 disabled:bg-foreground/50',
    secondary:    'bg-bg-200 text-foreground border border-border-200 hover:bg-bg-300 disabled:opacity-50',
    ghost:        'text-muted-foreground hover:text-foreground hover:bg-bg-300 disabled:opacity-50',
    danger:       'bg-danger-bg text-danger-fg border border-danger-border hover:bg-danger-fg hover:text-bg-100 disabled:opacity-50',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
    sm: 'h-8 px-3 text-xs gap-1.5',
    md: 'h-10 px-4 text-sm gap-2',
    lg: 'h-12 px-6 text-base gap-2.5',
};

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    leftIcon?: ReactNode;
    rightIcon?: ReactNode;
    children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        variant = 'primary',
        size = 'md',
        leftIcon,
        rightIcon,
        children,
        className,
        type = 'button',
        ...rest
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(
                // Base — comum a todos os variants
                'inline-flex items-center justify-center rounded-md font-medium',
                'transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                'disabled:cursor-not-allowed',
                VARIANT_CLASSES[variant],
                SIZE_CLASSES[size],
                className,
            )}
            {...rest}
        >
            {leftIcon}
            {children}
            {rightIcon}
        </button>
    );
});
