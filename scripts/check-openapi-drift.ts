/**
 * OpenAPI drift guard — FASE 13.4
 * ---------------------------------------------------------------------------
 * Re-exports the OpenAPI spec by running the live Fastify instance
 * and compares it to the checked-in `docs/api/openapi.{json,yaml}`.
 * If they differ, exits non-zero with a clear message so the author
 * knows to run `npm run openapi:export` and commit the result.
 *
 * Intended for CI (`npm run openapi:check`). Runs locally too:
 *     npm run openapi:check
 *
 * We compare the JSON representation (canonical) to avoid false
 * positives from YAML serialization differences. The YAML file is
 * always regenerated from the JSON, so if JSON matches, YAML will
 * either match or it's safe to regenerate the YAML alone.
 */

process.env.GOVAI_SKIP_LISTEN = 'true';

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fastify } from '../src/server';

const SPEC_PATH = path.join(__dirname, '..', 'docs', 'api', 'openapi.json');

async function main(): Promise<void> {
    if (!fs.existsSync(SPEC_PATH)) {
        console.error(`✗ Missing ${SPEC_PATH}. Run: npm run openapi:export`);
        process.exit(1);
    }
    const expected = fs.readFileSync(SPEC_PATH, 'utf8');

    try {
        await fastify.ready();
        const live = (fastify as unknown as { swagger: () => unknown }).swagger();
        const actual = JSON.stringify(live, null, 2) + '\n';

        if (actual === expected) {
            console.log('✓ docs/api/openapi.json is up to date');
            return;
        }

        // Show a small summary so CI logs are useful; avoid dumping the
        // entire diff (it would be huge and the developer has the tools
        // to run a real diff locally).
        const expectedPaths = Object.keys(JSON.parse(expected).paths ?? {}).sort();
        const actualPaths = Object.keys((live as { paths?: Record<string, unknown> }).paths ?? {}).sort();
        const added = actualPaths.filter(p => !expectedPaths.includes(p));
        const removed = expectedPaths.filter(p => !actualPaths.includes(p));

        console.error('✗ OpenAPI spec has drifted from the live API.');
        if (added.length) {
            console.error(`  ${added.length} route(s) added (not in committed spec):`);
            for (const p of added.slice(0, 20)) console.error(`    + ${p}`);
            if (added.length > 20) console.error(`    … and ${added.length - 20} more`);
        }
        if (removed.length) {
            console.error(`  ${removed.length} route(s) removed (still in committed spec):`);
            for (const p of removed.slice(0, 20)) console.error(`    - ${p}`);
            if (removed.length > 20) console.error(`    … and ${removed.length - 20} more`);
        }
        if (!added.length && !removed.length) {
            console.error('  Path set identical; request/response shapes differ.');
        }
        console.error('\nTo fix: npm run openapi:export && git add docs/api/openapi.*');
        process.exit(1);
    } finally {
        try {
            await fastify.close();
        } catch { /* ignore */ }
    }
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
        console.error('Drift check failed:', err);
        process.exit(1);
    });
