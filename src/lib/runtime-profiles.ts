/**
 * Runtime Profiles — FASE 7
 * ---------------------------------------------------------------------------
 * Polymorphic runtime catalog and resolver.
 *
 * The platform routes delegated work items to ONE of two runtimes today:
 *
 *   - claude_code_official  → claude-code-runner (Anthropic Claude Code CLI)
 *   - openclaude            → openclaude-runner  (the open multi-provider runner)
 *
 * Both runtimes speak the same gRPC protocol (openclaude.proto), so from the
 * adapter's point of view the only thing that changes between them is the
 * gRPC target (host or unix socket). This file is the single source of truth
 * for which target to pick.
 *
 * Selection priority used by resolveRuntimeProfile():
 *   1. Explicit slug the caller passed in (chat body or API request)
 *   2. Assistant preference with runtime_selection_mode = 'fixed'
 *      (a 'user_selectable' assistant exposes a default but the user can
 *      still override via the explicit slug path above)
 *   3. System default (is_default = true in runtime_profiles)
 *   4. Hard-coded fallback to 'openclaude'
 *
 * Every selection is isolated per org via RLS — the caller must open a
 * PoolClient and run `SELECT set_config('app.current_org_id', ...)` before
 * querying, which this module does internally for each function.
 */

import { Pool, PoolClient } from 'pg';
import { redisCache } from './redis';

// ── Types ──────────────────────────────────────────────────────────────────

export type RuntimeClass = 'official' | 'open' | 'human' | 'internal';

export interface RuntimeCapabilities {
    commands?: boolean;
    agents?: boolean;
    skills?: boolean;
    hooks?: boolean;
    mcp?: boolean;
    tool_loop?: boolean;
}

export interface RuntimeConfig {
    capabilities: RuntimeCapabilities;
    transport: {
        mode: string;
        proto?: string;
    };
    security: {
        requires_vault_secrets?: boolean;
        requires_workspace_isolation?: boolean;
    };
    approval: {
        supported_modes: string[];
        default_mode: string;
    };
    /**
     * Claim levels:
     * - 'official_cli_governed': Claude Code CLI in print mode, governed by GovAI.
     *   Functional but not equivalent to the full interactive runtime.
     * - 'exact_governed': RESERVED for future implementation via Claude Agent SDK.
     *   Do NOT use until the SDK adapter is implemented and tested.
     * - 'open_governed': OpenClaude runtime, multi-provider, compatible.
     */
    claim_level: string;
    container_service: string;
    grpc_host_env: string;
    socket_path_env: string;
}

export interface RuntimeProfile {
    id: string;
    org_id: string | null;
    slug: string;
    display_name: string;
    runtime_class: RuntimeClass;
    engine_vendor: string;
    engine_family: string;
    config: RuntimeConfig;
    status: string;
    is_default: boolean;
    created_at?: string;
    updated_at?: string;
}

export type ResolutionSource =
    | 'user_selected'
    | 'assistant_default'
    | 'tenant_default'
    | 'system_default'
    // FASE 8 additions:
    | 'explicit_request'
    | 'case_selected'
    | 'template_fixed'
    | 'global_fallback';

export interface RuntimeResolution {
    profile: RuntimeProfile;
    source: ResolutionSource;
    claim_level: string;
    /** FASE 8: true when the resolver could not honor the preferred/higher-priority
     *  binding and fell through to a lower-priority layer. Always false for
     *  explicit_request (which throws instead of falling back). */
    fallbackApplied?: boolean;
    fallbackReason?: string;
}

/**
 * gRPC target description returned by resolveRuntimeTarget().
 * Shaped to match OpenClaudeRunConfig in openclaude-client.ts so adapters
 * can pass it straight through without reshaping.
 */
export interface RuntimeTarget {
    host: string;
    socketPath?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Row → RuntimeProfile. Defensive: falls back to the open_governed defaults
 * when a column is missing or the JSONB shape is not what we expect, so a
 * partial/corrupt seed never crashes the resolver.
 */
function rowToProfile(row: Record<string, unknown>): RuntimeProfile {
    const rawConfig = (row.config ?? {}) as Record<string, unknown>;
    const cfg: RuntimeConfig = {
        capabilities: (rawConfig.capabilities as RuntimeCapabilities | undefined) ?? {},
        transport: (rawConfig.transport as RuntimeConfig['transport'] | undefined) ?? { mode: 'grpc' },
        security: (rawConfig.security as RuntimeConfig['security'] | undefined) ?? {},
        approval: (rawConfig.approval as RuntimeConfig['approval'] | undefined)
            ?? { supported_modes: ['single'], default_mode: 'single' },
        claim_level: (rawConfig.claim_level as string | undefined) ?? 'open_governed',
        container_service: (rawConfig.container_service as string | undefined) ?? 'openclaude-runner',
        grpc_host_env: (rawConfig.grpc_host_env as string | undefined) ?? 'OPENCLAUDE_GRPC_HOST',
        socket_path_env: (rawConfig.socket_path_env as string | undefined) ?? 'OPENCLAUDE_SOCKET_PATH',
    };
    return {
        id: row.id as string,
        org_id: (row.org_id as string | null) ?? null,
        slug: row.slug as string,
        display_name: row.display_name as string,
        runtime_class: (row.runtime_class as RuntimeClass) ?? 'open',
        engine_vendor: (row.engine_vendor as string) ?? 'unknown',
        engine_family: (row.engine_family as string) ?? 'unknown',
        config: cfg,
        status: (row.status as string) ?? 'active',
        is_default: Boolean(row.is_default),
        created_at: row.created_at as string | undefined,
        updated_at: row.updated_at as string | undefined,
    };
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when the caller explicitly requests a runtime that exists in the
 * catalog but whose container / socket is not reachable. The dispatch
 * pipeline converts this into an HTTP 503 with code RUNTIME_UNAVAILABLE
 * instead of silently falling back to a different runtime.
 */
export class RuntimeUnavailableError extends Error {
    public readonly runtimeSlug: string;
    public readonly code = 'RUNTIME_UNAVAILABLE' as const;

    constructor(slug: string, message: string) {
        super(message);
        this.runtimeSlug = slug;
        this.name = 'RuntimeUnavailableError';
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve which runtime profile should run this work item/turn. Follows the
 * priority chain documented in the file header. Never rejects — worst case
 * it returns the 'openclaude' hard-coded fallback so the caller can always
 * make forward progress.
 */
export async function resolveRuntimeProfile(
    pool: Pool,
    orgId: string,
    options: {
        /** Explicit slug passed by the caller (chat body, API request). */
        explicitSlug?: string;
        /** Assistant scope — used to honor `runtime_selection_mode = 'fixed'`. */
        assistantId?: string;
    } = {}
): Promise<RuntimeResolution> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Explicit selection wins.
        //    FIX 3 (FASE 7-fix): when the user explicitly requests a
        //    runtime, we check availability BEFORE returning. If the
        //    container is down we throw RuntimeUnavailableError instead
        //    of silently falling through to the system default, which
        //    would let the user think they're on Official when they're
        //    actually on Open — unacceptable in a production product.
        if (options.explicitSlug) {
            const r = await client.query(
                `SELECT * FROM runtime_profiles
                 WHERE slug = $1
                   AND (org_id = $2 OR org_id IS NULL)
                   AND status = 'active'
                 ORDER BY org_id DESC NULLS LAST
                 LIMIT 1`,
                [options.explicitSlug, orgId]
            );
            if (r.rows[0]) {
                const profile = rowToProfile(r.rows[0]);
                // Availability gate: only for runtimes that require an
                // external container (official, open). Human and internal
                // adapters don't have a container dependency.
                if (profile.runtime_class === 'official' || profile.runtime_class === 'open') {
                    if (!isRuntimeAvailable(profile)) {
                        throw new RuntimeUnavailableError(
                            options.explicitSlug,
                            `Runtime "${profile.display_name}" não está disponível. Verifique se o container está rodando.`
                        );
                    }
                }
                return { profile, source: 'user_selected', claim_level: profile.config.claim_level };
            }
        }

        // 2. Assistant preference (fixed mode only).
        if (options.assistantId) {
            const a = await client.query(
                `SELECT runtime_profile_slug, runtime_selection_mode
                 FROM assistants
                 WHERE id = $1 AND org_id = $2`,
                [options.assistantId, orgId]
            );
            const aRow = a.rows[0];
            if (aRow?.runtime_profile_slug && aRow.runtime_selection_mode === 'fixed') {
                const r = await client.query(
                    `SELECT * FROM runtime_profiles
                     WHERE slug = $1
                       AND (org_id = $2 OR org_id IS NULL)
                       AND status = 'active'
                     ORDER BY org_id DESC NULLS LAST
                     LIMIT 1`,
                    [aRow.runtime_profile_slug, orgId]
                );
                if (r.rows[0]) {
                    const profile = rowToProfile(r.rows[0]);
                    return { profile, source: 'assistant_default', claim_level: profile.config.claim_level };
                }
            }
        }

        // 3. System default (prefers an org-scoped default over the global one).
        const d = await client.query(
            `SELECT * FROM runtime_profiles
             WHERE is_default = true
               AND (org_id = $1 OR org_id IS NULL)
               AND status = 'active'
             ORDER BY org_id DESC NULLS LAST
             LIMIT 1`,
            [orgId]
        );
        if (d.rows[0]) {
            const profile = rowToProfile(d.rows[0]);
            const source: ResolutionSource = profile.org_id ? 'tenant_default' : 'system_default';
            return { profile, source, claim_level: profile.config.claim_level };
        }

        // 4. Hard-coded fallback to openclaude. If this row is missing too,
        //    the platform is in a bad state — we throw so the caller can
        //    surface a clear error instead of silently running nothing.
        const f = await client.query(
            `SELECT * FROM runtime_profiles WHERE slug = 'openclaude' AND status = 'active' LIMIT 1`
        );
        if (f.rows[0]) {
            const profile = rowToProfile(f.rows[0]);
            return { profile, source: 'system_default', claim_level: profile.config.claim_level };
        }
        throw new Error('No runtime profile available (missing openclaude seed)');
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

/**
 * List runtime profiles visible to this org. Global rows (org_id IS NULL)
 * are always included; org-scoped rows are filtered by RLS.
 */
export async function listRuntimeProfiles(
    pool: Pool,
    orgId: string
): Promise<RuntimeProfile[]> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const r = await client.query(
            `SELECT * FROM runtime_profiles
             WHERE (org_id = $1 OR org_id IS NULL)
               AND status = 'active'
             ORDER BY runtime_class ASC, display_name ASC`,
            [orgId]
        );
        return r.rows.map(rowToProfile);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

/**
 * Record a runtime switch in runtime_switch_audit. The route layer calls
 * this after successfully persisting the new preference (e.g. updating
 * assistants.runtime_profile_slug).
 */
export async function recordRuntimeSwitch(
    pool: Pool,
    orgId: string,
    userId: string,
    scopeType: 'tenant' | 'assistant' | 'template' | 'case' | 'work_item',
    scopeId: string,
    fromSlug: string | null,
    toSlug: string,
    reason?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        await client.query(
            `INSERT INTO runtime_switch_audit
                (org_id, actor_user_id, scope_type, scope_id,
                 from_runtime_slug, to_runtime_slug, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orgId, userId, scopeType, scopeId, fromSlug, toSlug, reason ?? null]
        );
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

/**
 * Resolve the gRPC target for a runtime profile using process env.
 * Prefers unix socket when the configured *_SOCKET_PATH var is set
 * (lower latency, no TCP exposure), otherwise falls back to TCP via
 * the *_GRPC_HOST var. Final fallback: <container_service>:50051.
 *
 * Shape matches the { host, socketPath? } argument that
 * executeOpenClaudeRun() in openclaude-client.ts already accepts.
 */
export function resolveRuntimeTarget(profile: RuntimeProfile): RuntimeTarget {
    const socketPath = process.env[profile.config.socket_path_env];
    if (socketPath && socketPath.trim()) {
        return {
            socketPath: socketPath.trim(),
            host: process.env[profile.config.grpc_host_env]
                || `${profile.config.container_service}:50051`,
        };
    }
    const host = process.env[profile.config.grpc_host_env];
    if (host && host.trim()) return { host: host.trim() };
    return { host: `${profile.config.container_service}:50051` };
}

/**
 * Lightweight availability check. For unix sockets we actually test the
 * filesystem handle; for TCP we just confirm the host env var is set (we
 * can't open a TCP connection here without the risk of hanging a request).
 * The check is deliberately conservative: `false` means "almost certainly
 * unreachable", `true` means "configured, proceed and let the adapter
 * surface any real connectivity error".
 */
export function isRuntimeAvailable(profile: RuntimeProfile): boolean {
    // FASE 13.5a3: align availability check with the real connection
    // logic in `resolveRuntimeTarget()`. Previously, when the configured
    // unix socket was missing we returned `false` immediately — which
    // flagged the runtime as "Indisponível" in the UI even though the
    // adapter already has a clean TCP fallback and can reach the sidecar
    // over `container_service:50051`. The symptom: claude-code-runner
    // was `Up (healthy)` on TCP but `EACCES` on the shared socket volume
    // (uid conflict), and the UI refused to offer it.
    //
    // New rule: try the socket first; if it doesn't exist / isn't
    // readable, fall through to the TCP host check. Return `true` when
    // either transport is configured and let the adapter surface a real
    // gRPC connection error at call time if neither works.
    const socketPath = process.env[profile.config.socket_path_env];
    if (socketPath && socketPath.trim()) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs') as typeof import('fs');
            fs.accessSync(socketPath.trim());
            return true;
        } catch {
            // Socket not accessible — do NOT early-return; fall through
            // to the TCP host check below.
        }
    }
    const host = process.env[profile.config.grpc_host_env];
    if (host && host.trim()) {
        // TCP host configured. Adapter connects lazily and surfaces a
        // specific error code if the port is actually dead.
        return true;
    }
    return false;
}

/**
 * Drop all cached runtime-health values (or a specific slug). Called on
 * api boot so the new `isRuntimeAvailable` semantics take effect
 * immediately rather than waiting for the 30 s TTL to expire. Safe to
 * call when Redis is down — no-op.
 */
export async function invalidateRuntimeHealthCache(slug?: string): Promise<void> {
    if (redisCache.status !== 'ready') return;
    try {
        if (slug) {
            await redisCache.del(`runtime:health:${slug}`);
            return;
        }
        const keys = await redisCache.keys('runtime:health:*');
        if (keys.length > 0) {
            await redisCache.del(...keys);
        }
    } catch {
        /* best-effort — next probe will repopulate */
    }
}

// ── FASE 8 — Cached health + 5-layer resolver ─────────────────────────────

/**
 * Cached wrapper around isRuntimeAvailable with a 30-second Redis TTL.
 * Falls back to the synchronous probe when Redis is unavailable.
 */
export async function isRuntimeAvailableCached(profile: RuntimeProfile): Promise<boolean> {
    const cacheKey = `runtime:health:${profile.slug}`;
    try {
        if (redisCache.status === 'ready') {
            const cached = await redisCache.get(cacheKey);
            if (cached !== null) return cached === 'true';
        }
    } catch { /* Redis down → probe directly */ }

    const available = isRuntimeAvailable(profile);

    // FASE 12: track probe outcomes for claude_code_official so operators
    // see how often /v1/admin/runtimes is hit (zero-cost) vs real billable
    // calls. Uses require() to avoid circular import during module init.
    if (profile.slug === 'claude_code_official') {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { recordClaudeCodeProbe } = require('./sre-metrics');
            recordClaudeCodeProbe(available ? 'success' : 'failure');
        } catch { /* metrics optional */ }
    }

    try {
        if (redisCache.status === 'ready') {
            await redisCache.set(cacheKey, available ? 'true' : 'false', 'EX', 30);
        }
    } catch { /* non-fatal — next call will re-probe */ }

    return available;
}

/**
 * Helper: fetch a profile by slug within an already-configured client
 * (caller has already run set_config).
 */
async function getProfileBySlug(
    client: PoolClient,
    slug: string,
    orgId: string
): Promise<RuntimeProfile | null> {
    const r = await client.query(
        `SELECT * FROM runtime_profiles
         WHERE slug = $1
           AND (org_id = $2 OR org_id IS NULL)
           AND status = 'active'
         ORDER BY org_id DESC NULLS LAST
         LIMIT 1`,
        [slug, orgId]
    );
    return r.rows[0] ? rowToProfile(r.rows[0]) : null;
}

/**
 * FASE 8 — 5-layer runtime resolution.
 *
 * Priority chain:
 *   1. explicit_request  — caller passed explicitSlug (chat body)
 *   2. case_selected     — demand_case has selected_runtime_profile_id
 *   3. template_fixed    — workflow template with mode='fixed'
 *   4. assistant_default — assistants.runtime_profile_slug
 *   5. tenant_default    — runtime_profile_bindings scope_type='tenant'
 *   6. global_fallback   — slug='openclaude' hard-coded
 *
 * Explicit + unavailable → throws RuntimeUnavailableError (no fallback).
 * Implicit layers skip unavailable profiles and fall through silently.
 */
export async function resolveRuntimeForExecution(
    pool: Pool,
    orgId: string,
    opts: {
        explicitSlug?: string;
        caseId?: string;
        workflowTemplateId?: string;
        assistantId?: string;
    } = {}
): Promise<RuntimeResolution> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Explicit request — hard-fail if unavailable (no silent fallback).
        if (opts.explicitSlug) {
            const profile = await getProfileBySlug(client, opts.explicitSlug, orgId);
            if (profile) {
                if (profile.runtime_class === 'official' || profile.runtime_class === 'open') {
                    const avail = await isRuntimeAvailableCached(profile);
                    if (!avail) {
                        throw new RuntimeUnavailableError(
                            profile.slug,
                            `Runtime "${profile.display_name}" não está disponível. Verifique se o container está rodando.`
                        );
                    }
                }
                return {
                    profile,
                    source: 'explicit_request',
                    claim_level: profile.config.claim_level,
                    fallbackApplied: false,
                };
            }
        }

        // 2. Case selected (demand_cases.selected_runtime_profile_id).
        if (opts.caseId) {
            const r = await client.query(
                `SELECT rp.* FROM demand_cases dc
                 JOIN runtime_profiles rp ON rp.id = dc.selected_runtime_profile_id
                 WHERE dc.id = $1 AND dc.org_id = $2 AND rp.status = 'active'`,
                [opts.caseId, orgId]
            );
            if (r.rows[0]) {
                const profile = rowToProfile(r.rows[0]);
                const avail = await isRuntimeAvailableCached(profile);
                if (avail) {
                    return { profile, source: 'case_selected', claim_level: profile.config.claim_level, fallbackApplied: false };
                }
            }
        }

        // 3. Template fixed (architect_workflow_templates with mode='fixed').
        if (opts.workflowTemplateId) {
            const r = await client.query(
                `SELECT rp.* FROM architect_workflow_templates wt
                 JOIN runtime_profiles rp ON rp.id = wt.runtime_profile_id
                 WHERE wt.id = $1 AND wt.org_id = $2
                   AND wt.runtime_selection_mode = 'fixed'
                   AND rp.status = 'active'`,
                [opts.workflowTemplateId, orgId]
            );
            if (r.rows[0]) {
                const profile = rowToProfile(r.rows[0]);
                const avail = await isRuntimeAvailableCached(profile);
                if (avail) {
                    return { profile, source: 'template_fixed', claim_level: profile.config.claim_level, fallbackApplied: false };
                }
            }
        }

        // 4. Assistant default (assistants.runtime_profile_slug JOIN runtime_profiles).
        if (opts.assistantId) {
            const r = await client.query(
                `SELECT rp.* FROM assistants a
                 JOIN runtime_profiles rp ON rp.slug = a.runtime_profile_slug
                   AND (rp.org_id = a.org_id OR rp.org_id IS NULL)
                 WHERE a.id = $1 AND a.org_id = $2 AND rp.status = 'active'
                 ORDER BY rp.org_id DESC NULLS LAST
                 LIMIT 1`,
                [opts.assistantId, orgId]
            );
            if (r.rows[0]) {
                const profile = rowToProfile(r.rows[0]);
                const avail = await isRuntimeAvailableCached(profile);
                if (avail) {
                    return { profile, source: 'assistant_default', claim_level: profile.config.claim_level, fallbackApplied: false };
                }
            }
        }

        // 5. Tenant default (runtime_profile_bindings scope_type='tenant').
        const tenantBinding = await client.query(
            `SELECT rp.* FROM runtime_profile_bindings rpb
             JOIN runtime_profiles rp ON rp.id = rpb.runtime_profile_id
             WHERE rpb.org_id = $1
               AND rpb.scope_type = 'tenant'
               AND rp.status = 'active'
             ORDER BY rpb.priority ASC
             LIMIT 1`,
            [orgId]
        );
        if (tenantBinding.rows[0]) {
            const profile = rowToProfile(tenantBinding.rows[0]);
            const avail = await isRuntimeAvailableCached(profile);
            if (avail) {
                return { profile, source: 'tenant_default', claim_level: profile.config.claim_level, fallbackApplied: false };
            }
        }

        // 6. Global fallback → openclaude.
        const fallback = await client.query(
            `SELECT * FROM runtime_profiles WHERE slug = 'openclaude' AND status = 'active' LIMIT 1`
        );
        if (fallback.rows[0]) {
            const profile = rowToProfile(fallback.rows[0]);
            return {
                profile,
                source: 'global_fallback',
                claim_level: profile.config.claim_level,
                fallbackApplied: true,
                fallbackReason: 'no_explicit_binding',
            };
        }

        throw new Error('No runtime profile available (missing openclaude seed)');
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
