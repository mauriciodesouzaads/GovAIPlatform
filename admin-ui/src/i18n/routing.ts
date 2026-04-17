/**
 * i18n routing — FASE 13.3
 * ---------------------------------------------------------------------------
 * Locale registry + defaults. Consumed by both middleware and getRequestConfig.
 *
 * Approach: cookie-based locale (NO URL prefix). The admin app is not
 * public (no SEO/crawling), and preserving URL structure avoids moving
 * 23 page folders under `[locale]/`. The LocaleSwitcher writes
 * `NEXT_LOCALE` cookie; the middleware reads it and the i18n request
 * config picks it up.
 *
 * Trade-off vs. localePrefix='as-needed':
 *   - Same: full server-render in user's language, persistence across sessions
 *   - Lost: linkable /en/... URLs (not needed — this is an authenticated
 *           internal tool)
 */

export const LOCALES = ['pt-BR', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'pt-BR';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isSupportedLocale(candidate: unknown): candidate is Locale {
    return typeof candidate === 'string' && (LOCALES as readonly string[]).includes(candidate);
}
