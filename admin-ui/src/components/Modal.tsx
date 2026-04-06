'use client';

import React, { useEffect, useCallback } from 'react';
import { X } from 'lucide-react';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: ModalSize;
  footer?: React.ReactNode;
}

const sizeMap: Record<ModalSize, string> = {
  sm:  'max-w-sm',
  md:  'max-w-md',
  lg:  'max-w-lg',
  xl:  'max-w-2xl',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  footer,
}: ModalProps) {
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
      aria-describedby={description ? 'modal-description' : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={[
          'w-full bg-card border border-border rounded-2xl shadow-2xl',
          'animate-in fade-in zoom-in-95 duration-200',
          sizeMap[size],
        ].join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div>
              <h2 id="modal-title" className="text-base font-semibold text-foreground">
                {title}
              </h2>
              {description && (
                <p id="modal-description" className="text-xs text-muted-foreground mt-0.5">
                  {description}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Fechar modal"
              className="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
