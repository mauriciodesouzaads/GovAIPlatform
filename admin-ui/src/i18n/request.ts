/**
 * next-intl request config — FASE 13.3
 * ---------------------------------------------------------------------------
 * Resolves locale per request by reading the `NEXT_LOCALE` cookie. Falls
 * back to Accept-Language header, then DEFAULT_LOCALE.
 *
 * Bundles the matching messages/{locale}.json and exposes them to server
 * components via `getTranslations`.
 */

import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale, type Locale } from './routing';

function parseAcceptLanguage(header: string | null): Locale | null {
    if (!header) return null;
    // Match the first accepted tag that we support (case-insensitive).
    const entries = header.split(',').map(s => s.split(';')[0].trim());
    for (const tag of entries) {
        // Exact match first
        if (isSupportedLocale(tag)) return tag;
        // Degrade "pt" → "pt-BR", "en-US" → "en"
        if (tag.toLowerCase().startsWith('pt')) return 'pt-BR';
        if (tag.toLowerCase().startsWith('en')) return 'en';
    }
    return null;
}

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;

    let resolved: Locale;
    if (isSupportedLocale(cookieLocale)) {
        resolved = cookieLocale;
    } else {
        const headerStore = await headers();
        const fromAccept = parseAcceptLanguage(headerStore.get('accept-language'));
        resolved = fromAccept ?? DEFAULT_LOCALE;
    }

    return {
        locale: resolved,
        messages: (await import(`./messages/${resolved}.json`)).default,
    };
});
