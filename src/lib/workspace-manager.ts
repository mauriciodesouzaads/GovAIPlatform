/**
 * Workspace Manager — FASE 5-hardening
 *
 * Per-org, per-work-item filesystem workspaces for OpenClaude runs.
 * Each workspace is `${BASE}/${orgId}/${workItemId}` and is mounted into
 * the openclaude-runner container via a shared docker volume.
 *
 * Lifecycle:
 *   - createWorkspace: called when adapter starts a run
 *   - cleanupWorkspace: called in adapter finally
 *   - cleanupOrphanedWorkspaces: called on worker boot to garbage-collect
 *     workspaces older than GOVAI_WORKSPACE_MAX_AGE_HOURS (default 24h)
 *
 * The base path is overridable via GOVAI_WORKSPACE_BASE so production can
 * point at a tmpfs or persistent volume as needed.
 */

import { mkdirSync, rmSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const BASE_PATH = process.env.GOVAI_WORKSPACE_BASE || '/tmp/govai-workspaces';
const MAX_AGE_HOURS = parseInt(process.env.GOVAI_WORKSPACE_MAX_AGE_HOURS || '24', 10);

/**
 * Create the workspace directory for a given (org, work_item) pair.
 * Idempotent — safe to call repeatedly. Returns the absolute path.
 *
 * FASE 13.5b/0 — chmod 0o777 after creation so that runners with
 * different uids can all write (openclaude-runner runs as root,
 * claude-code-runner as node=1000, aider-runner as 1002). Without
 * this, the api (govai=1001) creates dirs with 0o755 and only it
 * can write — runners hit EACCES.
 *
 * This is safe because:
 *  - Directories live under BASE_PATH (/tmp/govai-workspaces)
 *  - Scoped per (org, work_item): no cross-tenant leakage
 *  - Ephemeral: cleanupWorkspace() removes them after each run
 *  - Only container-internal; never exposed to the host
 */
export function createWorkspace(orgId: string, workItemId: string): string {
    const path = join(BASE_PATH, orgId, workItemId);
    mkdirSync(path, { recursive: true });
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { chmodSync } = require('fs') as typeof import('fs');
        // Also chmod the parent org dir in case it was freshly created.
        chmodSync(join(BASE_PATH, orgId), 0o777);
        chmodSync(path, 0o777);
    } catch {
        /* non-fatal — if chmod fails the runner will surface EACCES, same as before */
    }
    return path;
}

/**
 * Recursively delete a workspace directory. Errors are logged but not thrown
 * — workspace cleanup must never break the main execution flow.
 */
export function cleanupWorkspace(workspacePath: string): void {
    if (!workspacePath) return;
    try {
        rmSync(workspacePath, { recursive: true, force: true });
    } catch (err) {
        console.warn(`[Workspace] Failed to cleanup ${workspacePath}: ${(err as Error).message}`);
    }
}

/**
 * Walk BASE_PATH and delete any per-work-item directory whose mtime is
 * older than MAX_AGE_HOURS. Called on worker boot to recover from
 * crashes that left workspaces behind.
 *
 * Returns the count of deleted workspaces.
 */
export function cleanupOrphanedWorkspaces(): number {
    let cleaned = 0;
    let orgs: string[];
    try {
        orgs = readdirSync(BASE_PATH);
    } catch {
        // base path doesn't exist yet — first boot
        return 0;
    }

    if (orgs.length === 0) return 0;

    const now = Date.now();
    const maxAgeMs = MAX_AGE_HOURS * 60 * 60 * 1000;

    for (const orgDir of orgs) {
        const orgPath = join(BASE_PATH, orgDir);
        try {
            for (const itemDir of readdirSync(orgPath)) {
                const itemPath = join(orgPath, itemDir);
                try {
                    const stat = statSync(itemPath);
                    if (now - stat.mtimeMs > maxAgeMs) {
                        rmSync(itemPath, { recursive: true, force: true });
                        cleaned++;
                    }
                } catch {
                    // skip individual file errors
                }
            }
        } catch {
            // skip org-level errors
        }
    }

    if (cleaned > 0) {
        console.log(`[Workspace] Cleaned ${cleaned} orphaned workspace(s)`);
    }
    return cleaned;
}

/**
 * Convenience helper for tests / inspection.
 */
export function getWorkspacePath(orgId: string, workItemId: string): string {
    return join(BASE_PATH, orgId, workItemId);
}
