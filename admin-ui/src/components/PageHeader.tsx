import React from 'react';

interface BadgeDef {
  label: string;
  variant: 'success' | 'warning' | 'error' | 'neutral';
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  badge?: BadgeDef;
}

const badgeVariants: Record<BadgeDef['variant'], string> = {
  success: 'bg-success-bg text-success-fg border border-success-border',
  warning: 'bg-warning-bg text-warning-fg border border-warning-border',
  error:   'bg-danger-bg text-danger-fg border border-danger-border',
  neutral: 'bg-secondary text-muted-foreground border border-border',
};

export function PageHeader({ title, subtitle, icon, actions, badge }: PageHeaderProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
            {icon}
          </div>
        )}
        <div>
          {/* 6c.B.3 CP1.D-A: font-serif (DM Serif Display) p/ headings principais.
              Peso 400 — DM Serif tem peso visual forte; bold ficaria pesado demais.
              Estilo Claude.ai: serif elegante em h1 de página, sans para resto. */}
          <h1 className="text-2xl font-serif font-normal text-foreground tracking-tight leading-tight">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>
          )}
        </div>
        {badge && (
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${badgeVariants[badge.variant]}`}>
            {badge.label}
          </span>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
