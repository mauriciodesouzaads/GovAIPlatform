'use client';

/**
 * LocaleSwitcher — FASE 13.3
 * ---------------------------------------------------------------------------
 * Cookie-based locale switch. Writes `NEXT_LOCALE` and triggers a router
 * refresh so server components re-render with the new locale.
 *
 * No URL prefix change: the admin app keeps the same URLs across
 * locales (see ADR-018 for rationale).
 */

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Globe } from 'lucide-react';
import { LOCALES, LOCALE_COOKIE, type Locale } from '@/i18n/routing';

const FLAGS: Record<Locale, string> = {
    'pt-BR': '🇧🇷',
    en: '🇺🇸',
};

const LABEL_KEY: Record<Locale, string> = {
    'pt-BR': 'pt-BR',
    en: 'en',
};

/**
 * Sets a long-lived cookie. Must match the name `NEXT_LOCALE` that
 * `src/i18n/request.ts` reads on the server.
 */
function setLocaleCookie(value: Locale) {
    const maxAge = 60 * 60 * 24 * 365; // 1 year
    const secure = location.protocol === 'https:' ? ';secure' : '';
    document.cookie = `${LOCALE_COOKIE}=${value};path=/;max-age=${maxAge};samesite=lax${secure}`;
}

export function LocaleSwitcher() {
    const locale = useLocale() as Locale;
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const t = useTranslations('locale');

    const onChange = (next: Locale) => {
        if (next === locale) return;
        setLocaleCookie(next);
        // Bust the RSC cache and re-render with new messages.
        startTransition(() => router.refresh());
    };

    return (
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border/30 text-xs text-muted-foreground">
            <Globe className="w-4 h-4 shrink-0" />
            <span className="sr-only">{t('switcher')}</span>
            <select
                value={locale}
                onChange={(e) => onChange(e.target.value as Locale)}
                disabled={pending}
                aria-label={t('switcher')}
                className="flex-1 bg-transparent outline-none disabled:opacity-50 text-foreground text-xs cursor-pointer"
            >
                {LOCALES.map((l) => (
                    <option key={l} value={l}>
                        {FLAGS[l]} {t(LABEL_KEY[l])}
                    </option>
                ))}
            </select>
        </label>
    );
}
