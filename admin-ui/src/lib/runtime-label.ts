/**
 * Runtime label helpers — FASE 13.5b.1 UX hotfix
 * ---------------------------------------------------------------------------
 * The chat UI used to build runtime-button labels from `claim_level` alone
 * ("Open Governed"). Once Aider shipped, both OpenClaude and Aider rendered
 * as "Open · Open Governed" and became visually indistinguishable. Fix:
 * prefer `display_name` for identity and push `claim_level` to a subtitle.
 *
 * Keep this file pure (no React, no fetch) so it's trivially unit-testable.
 */

/**
 * Canonical human-readable label for a runtime claim level.
 * Falls back to a humanized slug so a new claim_level added to the DB
 * still renders reasonably without a UI ship.
 */
export function claimLevelLabel(claimLevel: string | null | undefined): string {
    switch (claimLevel) {
        case 'official_cli_governed':
            return 'CLI Governed';
        case 'exact_governed':
            return 'Exact Governed';
        case 'open_governed':
            return 'Open Governed';
        case 'human':
            return 'Human';
        case 'internal':
            return 'Internal';
        default:
            return humanizeSlug(claimLevel ?? '');
    }
}

/**
 * Icon glyph for a runtime_class. Mirrors the historical "🔒 official / 🌐
 * everything else" pattern but centralized so additions (eg. 🤝 human,
 * 🔧 internal) land in one place.
 */
export function runtimeClassIcon(runtimeClass: string | null | undefined): string {
    switch (runtimeClass) {
        case 'official':
            return '🔒';
        case 'human':
            return '🤝';
        case 'internal':
            return '🔧';
        case 'open':
        default:
            return '🌐';
    }
}

/**
 * Short heading shown on the runtime button / header pill. Prefers the
 * server-provided `display_name` (so Aider and OpenClaude are visually
 * distinct) and only falls back to a humanized slug when display_name
 * is missing (defensive against partial DB seeds).
 */
export function runtimeHeading(rt: {
    slug: string;
    display_name?: string | null;
}): string {
    const dn = (rt.display_name ?? '').trim();
    if (dn) return dn;
    return humanizeSlug(rt.slug);
}

/**
 * Full compound label: "🌐 Aider · Open Governed". Used in tooltips and
 * the header badge where we have room for the claim subtitle.
 */
export function runtimeFullLabel(rt: {
    slug: string;
    display_name?: string | null;
    runtime_class?: string | null;
    claim_level?: string | null;
}): string {
    const icon = runtimeClassIcon(rt.runtime_class);
    const heading = runtimeHeading(rt);
    const claim = claimLevelLabel(rt.claim_level);
    return claim ? `${icon} ${heading} · ${claim}` : `${icon} ${heading}`;
}

/**
 * Turn a snake/kebab slug into a Title Case label. Conservative — this
 * is the *last* fallback, not the default. Real display_names come from
 * the DB.
 */
export function humanizeSlug(slug: string): string {
    if (!slug) return '';
    return slug
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}
