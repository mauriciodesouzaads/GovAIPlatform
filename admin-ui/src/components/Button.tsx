'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:     'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary:   'bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80',
  ghost:       'bg-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline:     'bg-transparent border border-border text-foreground hover:bg-secondary/50',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm:  'px-3 py-1.5 text-xs gap-1.5',
  md:  'px-4 py-2.5 text-sm gap-2',
  lg:  'px-6 py-3 text-base gap-2.5',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading}
      className={[
        'inline-flex items-center justify-center rounded-lg font-semibold transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantStyles[variant],
        sizeStyles[size],
        className,
      ].join(' ')}
    >
      {loading
        ? <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
        : icon
          ? <span className="shrink-0" aria-hidden="true">{icon}</span>
          : null}
      {children}
    </button>
  );
}
