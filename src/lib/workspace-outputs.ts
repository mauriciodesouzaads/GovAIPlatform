/**
 * Workspace outputs scanner — FASE 14.0/6a₂.C
 * ---------------------------------------------------------------------------
 * After a work_item finishes (RUN_COMPLETED), the runner has written zero
 * or more files to its workspace dir at /tmp/govai-workspaces/<org>/<wi>/.
 * This module walks that tree, registers each file in `work_item_outputs`,
 * and lets the api expose them through the download endpoints.
 *
 * Why a dedicated module:
 *   - Keeps runtime-delegation.ts focused on dispatch / streaming /
 *     evidence rather than filesystem accounting.
 *   - Easy to unit-test in isolation: `walkWorkspace` is pure, the
 *     INSERT path takes a Pool so a test can inject a fake.
 *   - Failure here MUST NOT block the run completion — the caller
 *     wraps in try/catch and proceeds even if the scan crashes.
 *
 * Invariants:
 *   - Multi-tenant isolation via org_id on every INSERT + RLS context.
 *   - Skip dotfiles, node_modules, .git — common noise that pollutes
 *     the outputs list and isn't user-relevant.
 *   - Skip files > MAX_OUTPUT_SIZE_BYTES (100 MB) — protects against
 *     accidental huge outputs (compiled binaries, large CSVs).
 *   - ON CONFLICT (work_item_id, filename) DO UPDATE — re-scans on
 *     retried runs replace stale rows rather than 23505-fail.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { lookup as mimeLookup } from 'mime-types';
import type { Pool } from 'pg';

const MAX_OUTPUT_SIZE_BYTES = 100 * 1024 * 1024;
const WORKSPACES_ROOT =
    process.env.GOVAI_WORKSPACE_BASE || '/tmp/govai-workspaces';

// FASE 14.0/6a₂.C — outputs are COPIED out of the ephemeral workspace
// into this permanent location so they survive cleanupWorkspace (which
// runs in dispatch's finally block, AFTER RUN_COMPLETED). Without the
// copy, work_item_outputs.storage_path would point at a wiped path
// and download endpoints would 410 Gone.
const OUTPUTS_ROOT =
    process.env.GOVAI_OUTPUTS_BASE || '/var/govai/work-item-outputs';

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.next',
    '__pycache__',
    '.venv',
    'venv',
]);

interface WalkedFile {
    relativePath: string;
    absolutePath: string;
}

/**
 * Recursively walk a directory yielding every regular file's path.
 * Symlinks are not followed (defends against an accidental loop or
 * a malicious /proc → /etc traversal). Errors on individual entries
 * are swallowed and logged via the caller's `log` (default: console).
 */
async function walkWorkspace(
    rootDir: string,
    base = '',
    log: (msg: string) => void = console.warn.bind(console),
): Promise<WalkedFile[]> {
    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        log(`[workspace-outputs] readdir failed at ${rootDir}: ${(err as Error).message}`);
        return [];
    }

    const out: WalkedFile[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(entry.name)) continue;

        const abs = path.join(rootDir, entry.name);
        const rel = base ? `${base}/${entry.name}` : entry.name;

        // Symlinks: skip outright. Following them invites traversal
        // attacks if the agent crafted a link to /etc.
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
            const sub = await walkWorkspace(abs, rel, log);
            out.push(...sub);
        } else if (entry.isFile()) {
            out.push({ relativePath: rel, absolutePath: abs });
        }
    }
    return out;
}

export interface CaptureResult {
    captured: number;
    skipped: number;
    total_bytes: number;
}

/**
 * Walks the work_item's workspace and inserts a row in
 * `work_item_outputs` for every regular file under MAX_OUTPUT_SIZE_BYTES.
 *
 * The pool argument is the same RLS-aware pg.Pool used by dispatch;
 * we set app.current_org_id once at the start so every INSERT is
 * scoped without per-row config calls.
 *
 * Caller (runtime-delegation `RUN_COMPLETED` handler) wraps this in
 * try/catch — a failure here DOES NOT change the run's status from
 * `done`. Outputs are a UX nice-to-have, not a correctness invariant.
 */
export async function captureWorkItemOutputs(
    pool: Pool,
    orgId: string,
    workItemId: string,
    log: { warn: (msg: string) => void; error: (msg: string) => void } = console,
): Promise<CaptureResult> {
    const wsPath = path.join(WORKSPACES_ROOT, orgId, workItemId);
    const files = await walkWorkspace(wsPath, '', log.warn.bind(log));

    if (files.length === 0) {
        return { captured: 0, skipped: 0, total_bytes: 0 };
    }

    const client = await pool.connect();
    let captured = 0;
    let skipped = 0;
    let totalBytes = 0;

    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        for (const file of files) {
            try {
                const stat = await fs.stat(file.absolutePath);
                if (!stat.isFile()) continue;
                if (stat.size > MAX_OUTPUT_SIZE_BYTES) {
                    skipped++;
                    log.warn(
                        `[workspace-outputs] skip ${file.relativePath}: ` +
                        `${stat.size}B exceeds ${MAX_OUTPUT_SIZE_BYTES}B limit`
                    );
                    continue;
                }

                const buffer = await fs.readFile(file.absolutePath);
                const sha = createHash('sha256').update(buffer).digest('hex');
                const mimeType = mimeLookup(file.absolutePath) || 'application/octet-stream';

                // Copy to permanent location keyed by (org, work_item, relativePath).
                // The workspace dir gets wiped by cleanupWorkspace right after the
                // RUN_COMPLETED handler finishes, so the original absolute path is
                // not stable for downloads. We keep a separate canonical copy here
                // and store its path on the row.
                const persistentPath = path.join(
                    OUTPUTS_ROOT, orgId, workItemId, file.relativePath
                );
                await fs.mkdir(path.dirname(persistentPath), { recursive: true });
                await fs.writeFile(persistentPath, buffer);

                await client.query(
                    `INSERT INTO work_item_outputs
                        (work_item_id, org_id, filename, mime_type,
                         size_bytes, sha256, storage_path)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (work_item_id, filename) DO UPDATE SET
                        mime_type    = EXCLUDED.mime_type,
                        size_bytes   = EXCLUDED.size_bytes,
                        sha256       = EXCLUDED.sha256,
                        storage_path = EXCLUDED.storage_path`,
                    [
                        workItemId,
                        orgId,
                        file.relativePath,
                        mimeType,
                        stat.size,
                        sha,
                        persistentPath,
                    ]
                );

                captured++;
                totalBytes += stat.size;
            } catch (err) {
                skipped++;
                log.error(
                    `[workspace-outputs] capture failed for ${file.relativePath}: ` +
                    (err as Error).message
                );
            }
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }

    if (captured > 0) {
        log.warn(
            `[workspace-outputs] work_item ${workItemId}: ` +
            `${captured} files captured, ${skipped} skipped, ${totalBytes}B total`
        );
    }
    return { captured, skipped, total_bytes: totalBytes };
}
