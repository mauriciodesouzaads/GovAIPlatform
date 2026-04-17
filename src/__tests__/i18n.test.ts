/**
 * i18n integrity — FASE 13.3
 * ---------------------------------------------------------------------------
 * Guarantees translation parity: every key that exists in pt-BR.json
 * must also exist in en.json (and vice-versa), down to nested paths.
 * Catches the most common i18n bug — a feature adding new strings
 * only in one language — at test time rather than at runtime.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MESSAGES_DIR = join(__dirname, '..', '..', 'admin-ui', 'src', 'i18n', 'messages');

type MessagesTree = Record<string, unknown>;

function load(filename: string): MessagesTree {
    const raw = readFileSync(join(MESSAGES_DIR, filename), 'utf8');
    return JSON.parse(raw);
}

/** Collect every leaf key path (e.g. "bias.verdict.pass") in the tree. */
function collectKeyPaths(obj: MessagesTree, prefix = ''): string[] {
    const paths: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        const next = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            paths.push(...collectKeyPaths(value as MessagesTree, next));
        } else {
            paths.push(next);
        }
    }
    return paths.sort();
}

describe('i18n key parity', () => {
    const pt = load('pt-BR.json');
    const en = load('en.json');
    const ptKeys = collectKeyPaths(pt);
    const enKeys = collectKeyPaths(en);

    it('pt-BR has at least 150 keys (guards against accidental truncation)', () => {
        expect(ptKeys.length).toBeGreaterThanOrEqual(150);
    });

    it('en has at least 150 keys', () => {
        expect(enKeys.length).toBeGreaterThanOrEqual(150);
    });

    it('every pt-BR key exists in en', () => {
        const missing = ptKeys.filter(k => !enKeys.includes(k));
        expect(missing, `Missing in en.json: ${missing.join(', ')}`).toEqual([]);
    });

    it('every en key exists in pt-BR', () => {
        const missing = enKeys.filter(k => !ptKeys.includes(k));
        expect(missing, `Missing in pt-BR.json: ${missing.join(', ')}`).toEqual([]);
    });

    it('no translation value is empty or just whitespace', () => {
        const walk = (tree: MessagesTree, locale: string, prefix = ''): string[] => {
            const bad: string[] = [];
            for (const [key, value] of Object.entries(tree)) {
                const next = prefix ? `${prefix}.${key}` : key;
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                    bad.push(...walk(value as MessagesTree, locale, next));
                } else if (typeof value === 'string' && value.trim() === '') {
                    bad.push(`${locale}:${next}`);
                }
            }
            return bad;
        };
        const empty = [...walk(pt, 'pt-BR'), ...walk(en, 'en')];
        expect(empty, `Empty translation values: ${empty.join(', ')}`).toEqual([]);
    });
});
