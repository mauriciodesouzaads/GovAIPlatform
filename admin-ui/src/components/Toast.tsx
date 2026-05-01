'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
    id: string;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const toast = useCallback((message: string, type: ToastType = 'success') => {
        const id = Math.random().toString(36).substr(2, 9);
        setToasts((prev) => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 5000);
    }, []);

    const removeToast = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };

    return (
        <ToastContext.Provider value={{ toast }}>
            {children}
            <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        role="alert"
                        aria-live="polite"
                        className={`
              pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-md animate-in slide-in-from-right-full duration-300
              ${t.type === 'success' ? 'bg-success-bg border-success-border text-emerald-500' : ''}
              ${t.type === 'error' ? 'bg-danger-bg border-danger-border text-danger-fg' : ''}
              ${t.type === 'info' ? 'bg-info-bg border-info-border text-info-fg' : ''}
            `}
                    >
                        {t.type === 'success' && <CheckCircle2 className="w-5 h-5" />}
                        {t.type === 'error' && <AlertCircle className="w-5 h-5" />}
                        {t.type === 'info' && <Info className="w-5 h-5" />}

                        <span className="text-sm font-semibold">{t.message}</span>

                        <button
                            onClick={() => removeToast(t.id)}
                            className="ml-2 p-1 hover:bg-secondary/50 rounded-lg transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}
