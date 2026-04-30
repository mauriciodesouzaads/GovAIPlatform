'use client';

/**
 * FASE 14.0/6c.B.3 CP1 — Theme System
 * ---------------------------------------------------------------------------
 * Provedor de tema com 3 modos:
 *   - 'system' (default) — segue prefers-color-scheme do OS
 *   - 'light'  — força claro
 *   - 'dark'   — força escuro
 *
 * Persistência: localStorage('govai-theme'). Valores válidos:
 *   "system" | "light" | "dark". Qualquer outro vira 'system' default.
 *
 * Aplicação: toggle classe `.dark` em <html>. Tailwind v4 + @custom-variant
 * em globals.css picam essa classe e invertem todas as CSS vars dos tokens
 * automaticamente.
 *
 * FOUC: NO_FOUC_SCRIPT abaixo é injetado inline no <head> antes do React
 * montar — lê localStorage + matchMedia e aplica .dark/.light class na
 * primeira pintura. Sem ele, página renderiza no default (light) e flash
 * para dark quando o ThemeProvider hydrata.
 */

import {
    createContext, useContext, useEffect, useState, useCallback,
} from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
    /** Preferência do usuário (raw — pode ser 'system') */
    mode: ThemeMode;
    setMode: (mode: ThemeMode) => void;
    /** Tema efetivamente aplicado ('light' | 'dark') após resolução do system */
    resolved: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'govai-theme';

function readStored(): ThemeMode {
    if (typeof localStorage === 'undefined') return 'system';
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function resolveSystem(): 'light' | 'dark' {
    if (typeof window === 'undefined') return 'dark';  // SSR fallback
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // Inicial: lê localStorage no client. SSR cai em 'system' (resolvido depois).
    const [mode, setModeState] = useState<ThemeMode>('system');
    const [resolved, setResolved] = useState<'light' | 'dark'>('dark');

    // Hydrate do localStorage no primeiro mount + valor system inicial
    useEffect(() => {
        const stored = readStored();
        setModeState(stored);
    }, []);

    // Aplica .dark/.light no <html> sempre que mode muda OU OS muda
    useEffect(() => {
        const apply = () => {
            const next = mode === 'system' ? resolveSystem() : mode;
            setResolved(next);
            const root = document.documentElement;
            root.classList.toggle('dark',  next === 'dark');
            root.classList.toggle('light', next === 'light');
        };
        apply();

        // Listener de prefers-color-scheme só relevante quando 'system'.
        if (mode === 'system' && typeof window !== 'undefined') {
            const mql = window.matchMedia('(prefers-color-scheme: dark)');
            mql.addEventListener('change', apply);
            return () => mql.removeEventListener('change', apply);
        }
    }, [mode]);

    const setMode = useCallback((next: ThemeMode) => {
        setModeState(next);
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return (
        <ThemeContext.Provider value={{ mode, setMode, resolved }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
    return ctx;
}

/**
 * Script blocking inline para evitar FOUC. Inserir no <head> via
 * dangerouslySetInnerHTML antes do React montar — a classe .dark/.light
 * é aplicada na primeira pintura.
 *
 * Não usa ESM/imports (roda no browser sem bundler). Falha silenciosa
 * em ambientes sem localStorage (SSR de teste, etc.).
 */
export const NO_FOUC_SCRIPT = `(function(){try{var s=localStorage.getItem('govai-theme');var m=(s==='light'||s==='dark')?s:'system';var r=m==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;var c=document.documentElement.classList;c.add(r);if(r==='dark')c.remove('light');else c.remove('dark');}catch(e){}})();`;
