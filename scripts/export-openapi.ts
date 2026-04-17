/**
 * OpenAPI spec exporter — FASE 13.4
 * ---------------------------------------------------------------------------
 * Imports the real Fastify instance (with `GOVAI_SKIP_LISTEN=true` so the
 * module doesn't bind a port) and dumps the aggregated Swagger document
 * to `docs/api/openapi.{json,yaml}`.
 *
 * Used in CI as a drift guard: if a developer adds/modifies a route,
 * they must run this script and commit the updated spec, or CI fails
 * (see `npm run openapi:check`).
 *
 * Run locally:
 *   npx ts-node scripts/export-openapi.ts
 * Or via npm:
 *   npm run openapi:export
 */

process.env.GOVAI_SKIP_LISTEN = 'true';

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fastify } from '../src/server';

const OUT_DIR = path.join(__dirname, '..', 'docs', 'api');

async function main(): Promise<void> {
    try {
        await fastify.ready();
        const spec = (fastify as unknown as { swagger: () => unknown }).swagger();
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const jsonPath = path.join(OUT_DIR, 'openapi.json');
        const yamlPath = path.join(OUT_DIR, 'openapi.yaml');
        fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
        fs.writeFileSync(yamlPath, yaml.dump(spec, { noRefs: true, lineWidth: 120 }));
        console.log(`✓ Wrote ${jsonPath}`);
        console.log(`✓ Wrote ${yamlPath}`);
    } catch (err) {
        console.error('Failed to export OpenAPI spec:', err);
        process.exitCode = 1;
    } finally {
        try {
            await fastify.close();
        } catch { /* ignore — we're exiting anyway */ }
    }
}

main().then(() => process.exit(process.exitCode ?? 0));
