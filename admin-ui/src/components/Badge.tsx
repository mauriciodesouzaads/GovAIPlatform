import React from 'react';

export type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
}

const styles: Record<BadgeVariant, string> = {
  success: 'bg-success-bg text-success-fg border-success-border',
  warning: 'bg-warning-bg text-warning-fg border-warning-border',
  error:   'bg-danger-bg text-danger-fg border-danger-border',
  info:    'bg-info-bg text-info-fg border-info-border',
  neutral: 'bg-secondary text-muted-foreground border-border',
};

const dotColors: Record<BadgeVariant, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error:   'bg-rose-400',
  info:    'bg-blue-400',
  neutral: 'bg-muted-foreground',
};

export function Badge({ variant, children, dot, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${styles[variant]} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[variant]}`} />}
      {children}
    </span>
  );
}

// Convenience mapping helpers for common entity states
export function lifecycleBadge(status: string): BadgeVariant {
  const map: Record<string, BadgeVariant> = {
    draft: 'info',
    under_review: 'warning',
    approved: 'success',
    official: 'success',
    suspended: 'error',
    archived: 'neutral',
    published: 'success',
    active: 'success',
    inactive: 'neutral',
    revoked: 'error',
  };
  return map[status?.toLowerCase()] ?? 'neutral';
}

export function riskBadge(level: string): BadgeVariant {
  const map: Record<string, BadgeVariant> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
    critical: 'error',
  };
  return map[level?.toLowerCase()] ?? 'neutral';
}

export function findingBadge(status: string): BadgeVariant {
  const map: Record<string, BadgeVariant> = {
    open: 'warning',
    acknowledged: 'info',
    resolved: 'success',
    dismissed: 'neutral',
    promoted: 'error',
    accepted: 'neutral',
  };
  return map[status?.toLowerCase()] ?? 'neutral';
}

export function approvalBadge(status: string): BadgeVariant {
  const map: Record<string, BadgeVariant> = {
    pending: 'warning',
    approved: 'success',
    rejected: 'error',
  };
  return map[status?.toLowerCase()] ?? 'neutral';
}
