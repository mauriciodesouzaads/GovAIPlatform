'use client';

import React, { useEffect, useCallback } from 'react';
import { X } from 'lucide-react';

export type DrawerSide = 'left' | 'right';
export type DrawerSize = 'sm' | 'md' | 'lg';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  side?: DrawerSide;
  size?: DrawerSize;
  footer?: React.ReactNode;
}

const sideMap: Record<DrawerSide, string> = {
  right: 'right-0 top-0 h-full',
  left:  'left-0 top-0 h-full',
};

const sizeMap: Record<DrawerSize, string> = {
  sm: 'w-80',
  md: 'w-96',
  lg: 'w-[480px]',
};

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  side = 'right',
  size = 'md',
  footer,
}: DrawerProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex bg-background/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'drawer-title' : undefined}
      aria-describedby={description ? 'drawer-description' : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={[
          'fixed flex flex-col bg-card border-border shadow-2xl',
          side === 'right' ? 'border-l' : 'border-r',
          sideMap[side],
          sizeMap[size],
          'animate-in slide-in-from-right duration-200',
        ].join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <div>
              <h2 id="drawer-title" className="text-base font-semibold text-foreground">
                {title}
              </h2>
              {description && (
                <p id="drawer-description" className="text-xs text-muted-foreground mt-0.5">
                  {description}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Fechar painel"
              className="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
