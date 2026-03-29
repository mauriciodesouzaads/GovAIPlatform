/**
 * GovAI Platform — Shield Worker
 *
 * BullMQ Worker for the 'shield-collection' queue.
 * Handles 5 job types triggered by shield-schedule.job.ts:
 *
 *   collect-oauth      — Collects Microsoft OAuth grants via Graph API
 *   collect-google     — Collects Google Workspace activity observations
 *   generate-findings  — Generates Shield findings from rollup data (+ critical alert)
 *   dedupe-findings    — Deduplicates open findings per org
 *   posture-snapshot   — Generates executive posture snapshot per org
 *
 * Per-org isolation: errors in one org do NOT abort other orgs.
 * All DB operations use set_config/SET ROLE per established codebase pattern.
 */

import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { pgPool } from '../lib/db';
import {
    generateShieldFindings,
    dedupeFindings,
} from '../lib/shield';
import { generateExecutivePosture } from '../lib/shield-reporting.service';
import {
    recordCollectorSuccess,
    recordCollectorFailure,
} from '../lib/shield-collector-health';
import { collectMicrosoftOAuthGrants } from '../lib/shield-oauth-collector';
import {
    fetchGoogleObservations,
    ingestGoogleObservations,
} from '../lib/shield-google-collector';
import { mailer } from '../lib/mailer';
import { captureError } from '../lib/monitoring';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ShieldJobName =
    | 'collect-oauth'
    | 'collect-google'
    | 'generate-findings'
    | 'dedupe-findings'
    | 'posture-snapshot';

// ── Redis connection ──────────────────────────────────────────────────────────

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

connection.on('error', (err) => {
    console.error('[ShieldWorker] Redis connection error:', err);
});

// ── Helper — list all active orgs (cross-tenant) ─────────────────────────────

async function listActiveOrgs(pool: Pool): Promise<Array<{ id: string; name: string }>> {
    const client = await pool.connect();
    try {
        await client.query('SET ROLE platform_admin');
        const res = await client.query<{ id: string; name: string }>(
            `SELECT id, name FROM organizations ORDER BY created_at ASC`
        );
        return res.rows;
    } finally {
        try { await client.query('RESET ROLE'); } catch { /* no-op */ }
        client.release();
    }
}

// ── Helper — get first admin email for an org ─────────────────────────────────

async function getOrgAdminEmail(pool: Pool, orgId: string): Promise<string | null> {
    const client = await pool.connect();
    try {
        await client.query('SET ROLE platform_admin');
        const res = await client.query<{ email: string }>(
            `SELECT email FROM users WHERE org_id = $1 AND role = 'admin' LIMIT 1`,
            [orgId]
        );
        return res.rows[0]?.email ?? null;
    } finally {
        try { await client.query('RESET ROLE'); } catch { /* no-op */ }
        client.release();
    }
}

// ── Job handlers (exported for unit testing) ──────────────────────────────────

/**
 * collect-oauth — Queries all active OAuth collectors and calls
 * collectMicrosoftOAuthGrants for each one.
 * Gracefully skips if MICROSOFT_TOKEN is not set.
 */
export async function runCollectOAuth(pool: Pool): Promise<void> {
    const accessToken = process.env.MICROSOFT_TOKEN;
    if (!accessToken) {
        console.warn('[ShieldWorker] MICROSOFT_TOKEN not set — skipping collect-oauth');
        return;
    }

    const client = await pool.connect();
    let collectors: Array<{ id: string; org_id: string }> = [];
    try {
        await client.query('SET ROLE platform_admin');
        const res = await client.query<{ id: string; org_id: string }>(
            `SELECT id, org_id FROM shield_oauth_collectors WHERE status = 'active'`
        );
        collectors = res.rows;
    } finally {
        try { await client.query('RESET ROLE'); } catch { /* no-op */ }
        client.release();
    }

    for (const col of collectors) {
        try {
            await collectMicrosoftOAuthGrants(pool, col.org_id, col.id, accessToken);
            await recordCollectorSuccess(pool, 'oauth', col.id, col.org_id);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[ShieldWorker] collect-oauth error', {
                collectorId: col.id,
                orgId: col.org_id,
                error: msg,
            });
            await recordCollectorFailure(pool, 'oauth', col.id, col.org_id, msg).catch(() => { /* no-op */ });
        }
    }
}

/**
 * collect-google — Queries all active Google collectors and calls
 * fetchGoogleObservations + ingestGoogleObservations for each one.
 * Gracefully skips if GOOGLE_ADMIN_TOKEN is not set.
 */
export async function runCollectGoogle(pool: Pool): Promise<void> {
    const accessToken = process.env.GOOGLE_ADMIN_TOKEN;
    if (!accessToken) {
        console.warn('[ShieldWorker] GOOGLE_ADMIN_TOKEN not set — skipping collect-google');
        return;
    }

    const client = await pool.connect();
    let collectors: Array<{ id: string; org_id: string }> = [];
    try {
        await client.query('SET ROLE platform_admin');
        const res = await client.query<{ id: string; org_id: string }>(
            `SELECT id, org_id FROM shield_google_collectors WHERE status = 'active'`
        );
        collectors = res.rows;
    } finally {
        try { await client.query('RESET ROLE'); } catch { /* no-op */ }
        client.release();
    }

    for (const col of collectors) {
        try {
            const { activities, errors } = await fetchGoogleObservations(accessToken);
            if (errors.length > 0) {
                console.warn('[ShieldWorker] collect-google fetch errors', {
                    collectorId: col.id,
                    orgId: col.org_id,
                    errors,
                });
            }
            await ingestGoogleObservations(pool, col.org_id, col.id, activities);
            await recordCollectorSuccess(pool, 'google', col.id, col.org_id);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[ShieldWorker] collect-google error', {
                collectorId: col.id,
                orgId: col.org_id,
                error: msg,
            });
            await recordCollectorFailure(pool, 'google', col.id, col.org_id, msg).catch(() => { /* no-op */ });
        }
    }
}

/**
 * generate-findings — Runs generateShieldFindings for every org.
 * If critical/high findings are newly generated, sends a critical alert
 * to the org's admin email (TASK 5: alert integration).
 */
export async function runGenerateFindings(pool: Pool): Promise<void> {
    const orgs = await listActiveOrgs(pool);

    for (const org of orgs) {
        try {
            const result = await generateShieldFindings(pool, org.id);
            console.log('[ShieldWorker] generate-findings', {
                orgId: org.id,
                generated: result.generated,
                updated: result.updated,
            });

            // Send critical alert when new open findings were generated
            if (result.generated > 0) {
                const findClient = await pool.connect();
                let criticalTools: Array<{ toolName: string; riskScore: number }> = [];
                try {
                    await findClient.query(
                        "SELECT set_config('app.current_org_id', $1, false)", [org.id]
                    );
                    const critRes = await findClient.query<{ tool_name: string; risk_score: number }>(
                        `SELECT tool_name, COALESCE(risk_score, 0) AS risk_score
                         FROM shield_findings
                         WHERE org_id = $1
                           AND severity IN ('critical', 'high')
                           AND status = 'open'
                         ORDER BY risk_score DESC
                         LIMIT 5`,
                        [org.id]
                    );
                    criticalTools = critRes.rows.map(r => ({
                        toolName: r.tool_name,
                        riskScore: r.risk_score,
                    }));
                } finally {
                    await findClient.query(
                        "SELECT set_config('app.current_org_id', '', false)"
                    ).catch(() => { /* no-op */ });
                    findClient.release();
                }

                if (criticalTools.length > 0) {
                    const adminEmail = await getOrgAdminEmail(pool, org.id);
                    if (adminEmail) {
                        const adminUiUrl = process.env.ADMIN_UI_URL || 'http://localhost:3001';
                        await mailer.sendShieldCriticalAlert({
                            toEmail: adminEmail,
                            orgName: org.name,
                            findingCount: criticalTools.length,
                            criticalTools,
                            postureUrl: `${adminUiUrl}/shield`,
                        });
                    }
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[ShieldWorker] generate-findings error', { orgId: org.id, error: msg });
        }
    }
}

/**
 * dedupe-findings — Runs dedupeFindings for every org.
 */
export async function runDedupeFindings(pool: Pool): Promise<void> {
    const orgs = await listActiveOrgs(pool);

    for (const org of orgs) {
        try {
            const result = await dedupeFindings(pool, org.id);
            console.log('[ShieldWorker] dedupe-findings', {
                orgId: org.id,
                deduped: result.deduped,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[ShieldWorker] dedupe-findings error', { orgId: org.id, error: msg });
        }
    }
}

/**
 * posture-snapshot — Runs generateExecutivePosture for every org.
 */
export async function runPostureSnapshot(pool: Pool): Promise<void> {
    const orgs = await listActiveOrgs(pool);

    for (const org of orgs) {
        try {
            const posture = await generateExecutivePosture(pool, org.id, 'shield-worker');
            console.log('[ShieldWorker] posture-snapshot', {
                orgId: org.id,
                snapshotId: posture.snapshotId,
                summaryScore: posture.summaryScore,
                openFindings: posture.openFindings,
                unresolvedCritical: posture.unresolvedCritical,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[ShieldWorker] posture-snapshot error', { orgId: org.id, error: msg });
        }
    }
}

// ── Worker bootstrap ──────────────────────────────────────────────────────────

export function startShieldWorker(): Worker {
    const worker = new Worker<Record<string, unknown>>(
        'shield-collection',
        async (job: Job) => {
            const name = job.name as ShieldJobName;
            console.log(`[ShieldWorker] Processing job: ${name}`);

            switch (name) {
                case 'collect-oauth':
                    await runCollectOAuth(pgPool);
                    break;
                case 'collect-google':
                    await runCollectGoogle(pgPool);
                    break;
                case 'generate-findings':
                    await runGenerateFindings(pgPool);
                    break;
                case 'dedupe-findings':
                    await runDedupeFindings(pgPool);
                    break;
                case 'posture-snapshot':
                    await runPostureSnapshot(pgPool);
                    break;
                default:
                    console.warn(`[ShieldWorker] Unknown job name: ${name}`);
            }

            return { success: true, jobName: name };
        },
        { connection: connection as any }
    );

    worker.on('failed', (job: any, err: any) => {
        console.error(`[ShieldWorker] Job ${job?.id} (${job?.name}) failed:`, err);
        captureError(err instanceof Error ? err : new Error(String(err)), {
            job: 'shield-collection',
            jobId: job?.id,
            jobName: job?.name,
        });
    });

    console.log('[ShieldWorker] Started');
    return worker;
}
