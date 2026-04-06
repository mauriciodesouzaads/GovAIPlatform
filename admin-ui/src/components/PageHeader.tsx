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
  success: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  error:   'bg-rose-500/10 text-rose-400 border border-rose-500/20',
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
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{title}</h1>
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
