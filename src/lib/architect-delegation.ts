/**
 * Architect Delegation Router — Sprint A4/A5
 *
 * Reads work items with specific execution_hint values and routes them
 * to the appropriate adapter for execution.
 *
 * Conventions:
 *   - Same Pool + set_config pattern as architect.ts
 *   - Adapters update work item status in DB and record evidence
 *   - Human adapter is informational only (no DB state changes)
 *   - Max 3 dispatch attempts before marking blocked
 *   - dispatchWorkItem uses SELECT FOR UPDATE SKIP LOCKED for concurrency safety
 *
 * ─── FASE 13.5b/1 — refactor in progress ───────────────────────────────
 * This file is the legacy source of truth. New call sites should import
 * from `./delegation/orchestration`, `./delegation/dispatch`, or
 * `./delegation/governance` (or the convenience `./delegation` barrel)
 * instead of from this module directly. The `./delegation/*` submodules
 * are currently thin re-export shims that point back here; the physical
 * code move will happen in 13.5c once callers have migrated. Do not
 * add new public exports here without also referencing them from the
 * appropriate submodule.
 *
 * The folder is called `delegation/` (not `architect/`) because
 * `src/lib/architect.ts` already owns the "architect domain" namespace
 * (workflow graphs, decision sets, demand cases). This file's
 * responsibility is the delegation/execution layer that sits on top
 * of that domain, hence the separate folder name.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { searchSimilarChunks } from './rag';
import { recordEvidence } from './evidence';
import { resolveShieldLevel, requiresHitlForTool, type ShieldLevel } from './shield-level';
import { executeOpenClaudeRun, resolveOpenClaudeTarget } from './openclaude-client';
import { createWorkspace, cleanupWorkspace } from './workspace-manager';
import { registerStream, unregisterStream } from './architect-stream-registry';
import {
    resolveRuntimeProfile,
    resolveRuntimeForExecution,
    resolveRuntimeTarget,
    RuntimeTarget,
    RuntimeUnavailableError,
} from './runtime-profiles';
import { beforeCall as beforeCircuitCall, CircuitOpenError } from './circuit-breaker';

// ── Tool grant resolution (FASE 5-hardening) ─────────────────────────────────

export interface ToolDecision {
    action: 'allow' | 'deny' | 'requires_approval';
    reason: string;
}

/**
 * Tools that read but never write the filesystem or shell. Always allowed
 * regardless of org policy — they cannot exfiltrate or destroy.
 * Safelist mirrored from OpenClaude's tools.ts (View, Glob, Grep, etc.).
 */
const SAFE_READ_ONLY_TOOLS = new Set<string>([
    'View', 'FileReadTool',
    'Glob', 'GlobTool',
    'Grep', 'GrepTool',
    'LS', 'ListFilesTool',
    'ReadNotebook',
    'Think', 'ThinkTool',
    'NotebookRead',
    'TodoRead',
]);

/**
 * Tools that can mutate state (filesystem, shell, network). Default to
 * requires_approval. Org-level policy can opt-in via delegation_config.
 */
const DANGEROUS_TOOLS = new Set<string>([
    'Bash', 'BashTool',
    'FileWriteTool', 'Write',
    'FileEditTool', 'Edit', 'MultiEdit',
    'Replace',
    'WebFetch', 'WebFetchTool',
    'WebSearch', 'WebSearchTool',
    'NotebookEdit',
]);

/**
 * Decide whether a tool call from OpenClaude should be allowed automatically,
 * denied automatically, or escalated to a human approval. The decision is
 * based on a static safelist plus the org's delegation_config (when available).
 *
 * Pure-ish: opens its own DB connection only when needed for org policy.
 */
export async function resolveToolDecision(
    pool: Pool,
    orgId: string,
    workItemId: string,
    toolName: string
): Promise<ToolDecision> {
    void workItemId; // reserved for future per-item override

    if (SAFE_READ_ONLY_TOOLS.has(toolName)) {
        return { action: 'allow', reason: 'safe_read_only_tool' };
    }

    if (DANGEROUS_TOOLS.has(toolName)) {
        // Check if the org has explicitly opted-in to auto-approve dangerous tools.
        // We piggyback on the assistant delegation_config since the work item
        // execution_context already records assistant_id when it came from the
        // execution pipeline.
        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const wiRes = await client.query(
                `SELECT execution_context FROM architect_work_items WHERE id = $1 AND org_id = $2`,
                [workItemId, orgId]
            );
            const ctx = wiRes.rows[0]?.execution_context || {};
            const assistantId = ctx.assistant_id || ctx.assistantId;
            if (assistantId) {
                const aRes = await client.query(
                    `SELECT delegation_config FROM assistants WHERE id = $1 AND org_id = $2`,
                    [assistantId, orgId]
                );
                const dc = aRes.rows[0]?.delegation_config || {};
                const allowList: string[] = Array.isArray(dc.auto_allow_tools) ? dc.auto_allow_tools : [];
                if (allowList.includes(toolName)) {
                    return { action: 'allow', reason: `assistant ${assistantId} auto_allow_tools` };
                }
            }
            return { action: 'requires_approval', reason: `${toolName} requires human approval` };
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    }

    // Unknown tool → safest default is human approval.
    return { action: 'requires_approval', reason: 'unknown_tool_requires_approval' };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdapterResult {
    success: boolean;
    output: Record<string, unknown>;
    error?: string;
}

export interface DispatchResult {
    workItemId: string;
    adapter: string;
    success: boolean;
    output: Record<string, unknown>;
    error?: string;
}

// ── Delegation Decision (FASE 5d) ─────────────────────────────────────────────

export interface DelegationConfig {
    enabled: boolean;
    auto_delegate_patterns: string[];
    max_duration_seconds: number;
}

export interface DelegationDecision {
    shouldDelegate: boolean;
    reason?: string;
    matchedPattern?: string;
}

/**
 * Pure function: decides whether a message should be delegated to the Architect.
 *
 * Rules (in order):
 *   1. delegationConfig null or disabled → no delegation
 *   2. no patterns configured → no delegation
 *   3. first pattern that matches (case-insensitive regex) → delegate
 *   4. invalid regex → silently skipped (continue to next pattern)
 */
export function shouldDelegate(
    message: string,
    delegationConfig: DelegationConfig | null | undefined
): DelegationDecision {
    if (!delegationConfig || !delegationConfig.enabled) {
        return { shouldDelegate: false, reason: 'delegation_disabled' };
    }

    if (!Array.isArray(delegationConfig.auto_delegate_patterns)
        || delegationConfig.auto_delegate_patterns.length === 0) {
        return { shouldDelegate: false, reason: 'no_patterns' };
    }

    for (const pattern of delegationConfig.auto_delegate_patterns) {
        try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(message)) {
                return { shouldDelegate: true, matchedPattern: pattern };
            }
        } catch {
            // Invalid regex — skip silently
            continue;
        }
    }

    return { shouldDelegate: false, reason: 'no_pattern_match' };
}

/**
 * Map a leading runtime prefix — `[OPENCLAUDE]`, `[CLAUDE_CODE]`, or
 * `[AIDER]` — to the runtime_profile slug that should handle the work
 * item. Returns `null` when the message has no such prefix, so the
 * caller can fall back to the assistant / org / system default chain.
 *
 * Why this lives next to `shouldDelegate` and not in the dispatcher:
 * the prefix is semantically *part of the delegation decision* — it's
 * what tells us "delegate AND send it to this specific lane." The
 * dispatcher only cares which gRPC socket to hit given a slug; it
 * doesn't parse the user message.
 *
 * Case-insensitive match, tolerant of leading whitespace. We use a
 * prefix-only match (not .test of the full body) so a stray mention
 * of the token mid-message doesn't misroute. The regex patterns in
 * `auto_delegate_patterns` still decide *whether* to delegate — this
 * function only answers *which runtime*.
 */
export function runtimeFromPrefix(message: string | null | undefined): string | null {
    if (!message) return null;
    const trimmed = message.trimStart();
    const match = trimmed.match(/^\[(OPENCLAUDE|CLAUDE_CODE|AIDER)\]/i);
    if (!match) return null;
    const token = match[1].toUpperCase();
    switch (token) {
        case 'OPENCLAUDE':  return 'openclaude';
        case 'CLAUDE_CODE': return 'claude_code_official';
        case 'AIDER':       return 'aider';
        default:            return null;  // unreachable given the regex
    }
}

/**
 * Returns the singleton "auto-delegation" workflow_graph_id for an org.
 * Required because architect_work_items.workflow_graph_id is NOT NULL.
 *
 * The seed creates this workflow_graph at id 00000000-0000-0000-00B4-...001
 * with marker = "auto_delegation" in graph_json. This helper looks it up
 * by marker (not by hardcoded ID) so it works for any org that has been
 * properly seeded.
 *
 * Returns null if no marker found — caller must handle gracefully.
 */
export async function getAutoDelegationWorkflowGraphId(
    pool: Pool,
    orgId: string
): Promise<string | null> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `SELECT id FROM workflow_graphs
             WHERE org_id = $1
               AND graph_json->>'marker' = 'auto_delegation'
             ORDER BY created_at ASC LIMIT 1`,
            [orgId]
        );
        return res.rows.length > 0 ? (res.rows[0].id as string) : null;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Adapter: internal_rag ─────────────────────────────────────────────────────

export async function runInternalRagAdapter(
    pool: Pool,
    orgId: string,
    workItemId: string
): Promise<AdapterResult> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Fetch work item
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
        if (wiRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Work item not found' };
        }
        const item = wiRes.rows[0];

        if (item.execution_hint !== 'internal_rag') {
            return { success: false, output: {}, error: 'Wrong adapter for this item' };
        }
        if (item.status !== 'pending' && item.status !== 'in_progress') {
            return { success: false, output: {}, error: 'Work item not in dispatchable state' };
        }

        // 2. Mark in_progress
        await client.query(
            `UPDATE architect_work_items
             SET status = 'in_progress', dispatched_at = now(),
                 dispatch_attempts = dispatch_attempts + 1
             WHERE id = $1`,
            [workItemId]
        );

        // 3. Build search question
        const question: string = item.description ?? item.title;

        // 4. Look up knowledge base
        const kbRes = await client.query(
            `SELECT id FROM knowledge_bases WHERE org_id = $1 LIMIT 1`,
            [orgId]
        );

        if (kbRes.rows.length === 0) {
            const output = { snippets: [], message: 'No knowledge base configured' };
            await client.query(
                `UPDATE architect_work_items
                 SET status = 'done', completed_at = now(),
                     execution_context = $1
                 WHERE id = $2`,
                [JSON.stringify({ input: { question }, output, adapter: 'internal_rag' }), workItemId]
            );
            return { success: true, output };
        }

        const kbId: string = kbRes.rows[0].id;

        // 5. Search RAG
        const chunks = await searchSimilarChunks(pool, kbId, orgId, question, 5);

        // 6. Build output
        const snippets = chunks.map(c => ({
            source: kbId,
            content: c.content,
            score: c.similarity,
        }));
        const output = { snippets, question, kbId };

        // 7. Update work item as done
        await client.query(
            `UPDATE architect_work_items
             SET status = 'done', completed_at = now(),
                 execution_context = $1
             WHERE id = $2`,
            [
                JSON.stringify({
                    input: { question, kbId },
                    output: { snippets },
                    adapter: 'internal_rag',
                }),
                workItemId,
            ]
        );

        // 8. Record evidence
        await recordEvidence(pool, {
            orgId,
            category: 'data_access',
            eventType: 'ARCHITECT_ADAPTER_EXECUTED',
            resourceType: 'architect_work_item',
            resourceId: workItemId,
            metadata: { adapter: 'internal_rag', snippetCount: snippets.length },
        });

        // 9. Return result
        return { success: true, output };
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        try {
            // On error: update dispatch_error, check attempts for blocked state
            const attemptsRes = await client.query(
                `UPDATE architect_work_items
                 SET dispatch_error = $1,
                     dispatch_attempts = dispatch_attempts + 1,
                     status = CASE
                         WHEN dispatch_attempts + 1 >= 3 THEN 'blocked'
                         ELSE 'pending'
                     END
                 WHERE id = $2 AND org_id = $3
                 RETURNING dispatch_attempts`,
                [errorMsg, workItemId, orgId]
            );
            void attemptsRes;
        } catch {
            // Non-fatal — best effort error recording
        }
        return { success: false, output: {}, error: errorMsg };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Adapter: human ────────────────────────────────────────────────────────────

export async function runHumanAdapter(
    pool: Pool,
    orgId: string,
    workItemId: string
): Promise<AdapterResult> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Fetch and validate work item
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
        if (wiRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Work item not found' };
        }
        const item = wiRes.rows[0];

        // 2. Return informational output — no DB state changes
        return {
            success: true,
            output: {
                message: 'Human action required',
                item_type: item.item_type,
                title: item.title,
                description: item.description,
                ref_type: item.ref_type,
                ref_id: item.ref_id,
                instructions: 'Complete this task manually and update the work item status via PATCH /work-items/:id',
            },
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Adapter: agno (stub) ──────────────────────────────────────────────────────

export async function runAgnoAdapter(
    pool: Pool,
    orgId: string,
    workItemId: string,
    agnoEndpoint?: string
): Promise<AdapterResult> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Fetch work item
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
        if (wiRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Work item not found' };
        }
        const item = wiRes.rows[0];

        // 2. Validate execution_hint
        if (item.execution_hint !== 'agno') {
            return { success: false, output: {}, error: 'Wrong adapter for this item' };
        }

        // 3. Build agno payload
        const agnoPayload = {
            work_item_id: workItemId,
            item_type: item.item_type,
            title: item.title,
            description: item.description,
            execution_context_input: {
                orgId,
                ref_type: item.ref_type,
                ref_id: item.ref_id,
            },
        };

        // 4. If AGNO_ENABLED=true and endpoint provided: call Agno service
        if (agnoEndpoint && process.env.AGNO_ENABLED === 'true') {
            const response = await fetch(`${agnoEndpoint}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(agnoPayload),
            });
            const data = await response.json() as Record<string, unknown>;
            return { success: true, output: data };
        }

        // 5. Stub response — Agno not yet enabled
        const output = {
            stub: true,
            message: 'Agno adapter not yet enabled. Set AGNO_ENABLED=true and provide AGNO_ENDPOINT to activate.',
            payload: agnoPayload,
        };

        // Update execution_context; status stays 'pending' (stub does not complete item)
        await client.query(
            `UPDATE architect_work_items
             SET execution_context = $1
             WHERE id = $2`,
            [JSON.stringify({ adapter: 'agno', stub: true, payload: agnoPayload }), workItemId]
        );

        return { success: true, output };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Work item event helpers (FASE 5-hardening) ───────────────────────────────

/**
 * Append an entry to architect_work_item_events with monotonic event_seq.
 * Auto-touches last_event_at on the parent work item. Errors are swallowed
 * to avoid breaking the gRPC stream — the timeline is best-effort telemetry.
 */
export async function insertWorkItemEvent(
    pool: Pool,
    orgId: string,
    workItemId: string,
    eventType: string,
    payload: Record<string, unknown>,
    toolName?: string,
    promptId?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        // Compute next event_seq atomically using SELECT then INSERT inside a single statement
        await client.query(
            `INSERT INTO architect_work_item_events
                (org_id, work_item_id, event_type, event_seq, tool_name, prompt_id, payload)
             VALUES (
                $1, $2, $3,
                COALESCE((SELECT MAX(event_seq) + 1 FROM architect_work_item_events WHERE work_item_id = $2), 1),
                $4, $5, $6
             )`,
            [orgId, workItemId, eventType, toolName ?? null, promptId ?? null, JSON.stringify(payload)]
        );
        await client.query(
            `UPDATE architect_work_items SET last_event_at = NOW() WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
    } catch (err) {
        // Non-fatal: timeline event logging must never break the run
        console.warn('[Architect] insertWorkItemEvent failed:', (err as Error).message);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

/**
 * Parse a tool name from OpenClaude's "Approve <ToolName>?" question.
 * Falls back to 'unknown' so the registry rules can still apply.
 */
function parseToolNameFromQuestion(question: string | undefined): string {
    if (!question) return 'unknown';
    const m = question.match(/Approve\s+(\w+)\b/i);
    return m?.[1] || 'unknown';
}

// ── Adapter: gRPC runtime (openclaude + claude_code_official) ───────────────
// Event grammar (FASE 8 — see ADR-010):
//   RUN_STARTED      — emitted at step 5 below
//   TOOL_START        — emitted on emitter.tool_start
//   TOOL_RESULT       — emitted on emitter.tool_result
//   ACTION_REQUIRED   — emitted when decision.action === 'requires_approval'
//   ACTION_RESPONSE   — emitted after approval (auto_all, auto_safe, allow, deny)
//   RUN_COMPLETED     — emitted on emitter.done
//   RUN_FAILED        — emitted on emitter.error
//   TEXT_CHUNK        — deliberately NOT stored as events (too high-frequency for
//                       the event store; accumulated into fullText in the done handler)
//   RUN_CANCELLED     — recorded as status='cancelled' on the work item row; no
//                       dedicated event row (the cancel-run job sets the column).
// FASE 7: a single adapter now serves BOTH the open OpenClaude runtime and
// the Official Claude Code runtime. Both containers speak the same
// openclaude.proto — the only thing that changes between them is the gRPC
// target (host / unix socket). The caller passes either:
//
//   1. An explicit RuntimeProfileContext with a pre-resolved target (what
//      dispatchWorkItem() does now after running resolveRuntimeProfile()).
//   2. Nothing — the adapter falls back to resolveOpenClaudeTarget() + the
//      'openclaude' slug. This branch is kept so existing callers (tests,
//      internal jobs that haven't been migrated) continue to work.
//
// The public function name `runOpenClaudeAdapter` is preserved for backward
// compatibility; a named export `runGrpcRuntimeAdapter` is added as the
// canonical alias going forward.

export interface RuntimeAdapterContext {
    /** Runtime profile slug persisted on the work item. */
    runtimeProfileSlug: string;
    /** gRPC target (host + optional unix socket) for this runtime. */
    target: RuntimeTarget;
    /** Human-readable claim level for observability ('exact_governed' | 'open_governed'). */
    claimLevel?: string;
}

export async function runOpenClaudeAdapter(
    pool: Pool,
    orgId: string,
    workItemId: string,
    runtimeCtx?: RuntimeAdapterContext
): Promise<AdapterResult> {
    const client = await pool.connect();
    let workspacePath: string | null = null;
    let streamRegistered = false;

    // Default runtime — keeps the pre-FASE-7 behaviour for callers that
    // don't pass an explicit context. Named `runtime` (not `ctx`) to avoid
    // shadowing the existing `const ctx = item.execution_context` at step 3.
    const runtime: RuntimeAdapterContext = runtimeCtx ?? {
        runtimeProfileSlug: 'openclaude',
        target: resolveOpenClaudeTarget(),
        claimLevel: 'open_governed',
    };

    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Fetch work item
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
        if (wiRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Work item not found' };
        }
        const item = wiRes.rows[0];

        // Execution hint determines which adapter claims this item. FASE 7
        // accepts both 'openclaude' and 'claude_code' (official) hints —
        // both flow through the same gRPC adapter, routed to the container
        // identified by runtimeCtx.target.
        if (item.execution_hint !== 'openclaude' && item.execution_hint !== 'claude_code') {
            return { success: false, output: {}, error: 'Wrong adapter for this item' };
        }
        if (item.status !== 'pending' && item.status !== 'in_progress') {
            return { success: false, output: {}, error: 'Work item not in dispatchable state' };
        }

        // 2. Mark in_progress + record session + worker_runtime + runtime_profile_slug
        // worker_runtime keeps the legacy 'openclaude' value for backward
        // compat with every existing audit report; runtime_profile_slug is
        // the new FASE-7 field that distinguishes 'openclaude' from
        // 'claude_code_official'.
        const sessionId = randomUUID();
        await client.query(
            `UPDATE architect_work_items
             SET status = 'in_progress', dispatched_at = now(),
                 dispatch_attempts = dispatch_attempts + 1,
                 worker_session_id = $2, run_started_at = now(),
                 worker_runtime = 'openclaude', last_event_at = now(),
                 runtime_profile_slug = $3
             WHERE id = $1`,
            [workItemId, sessionId, runtime.runtimeProfileSlug]
        );

        // 3. Resolve skill instructions if delegated from an assistant (FASE 5-hardening)
        let skillInstructions = '';
        const ctx = (item.execution_context ?? {}) as Record<string, unknown>;
        const ctxAssistantId = (ctx.assistant_id ?? ctx.assistantId) as string | undefined;

        // FASE 13.5a: resolve the effective shield level for this run once,
        // outside the streaming loop. The action_required handler closes over
        // `shieldLevel` to decide whether to fast-path native runtime tool
        // use (levels 1 and 2) or to apply the classic classifier + HITL
        // pipeline (level 3 — preserved verbatim below).
        const shieldLevel: ShieldLevel = await resolveShieldLevel(pool, orgId, ctxAssistantId);
        if (ctxAssistantId) {
            try {
                const skillsRes = await client.query(
                    `SELECT cs.name, cs.instructions
                     FROM catalog_skills cs
                     JOIN assistant_skill_bindings asb ON cs.id = asb.skill_id
                     WHERE asb.assistant_id = $1 AND asb.org_id = $2
                       AND cs.is_active = true AND asb.is_active = true
                     ORDER BY cs.name`,
                    [ctxAssistantId, orgId]
                );
                if (skillsRes.rows.length > 0) {
                    skillInstructions = '\n\n## Skills Aplicáveis\n\n' +
                        skillsRes.rows.map(s => `### ${s.name}\n${s.instructions}`).join('\n\n');
                }
            } catch (skillErr) {
                console.warn('[OpenClaude] failed to resolve skills:', (skillErr as Error).message);
            }
        }

        // 4. Build instruction from work item fields + skills
        const instruction = [
            `## Task: ${item.title}`,
            item.description ? `\n${item.description}` : '',
            (ctx.instructions as string | undefined) ? `\n### Instructions\n${ctx.instructions}` : '',
            skillInstructions,
        ].filter(Boolean).join('\n');

        // 5. Record evidence: run started
        await recordEvidence(pool, {
            orgId,
            category: 'data_access',
            eventType: 'OPENCLAUDE_RUN_STARTED',
            resourceType: 'architect_work_item',
            resourceId: workItemId,
            metadata: {
                sessionId,
                adapter: 'openclaude',
                runtime_profile: runtime.runtimeProfileSlug,
                claim_level: runtime.claimLevel ?? 'open_governed',
                title: item.title,
            },
        });
        await insertWorkItemEvent(pool, orgId, workItemId, 'RUN_STARTED', {
            sessionId,
            title: item.title,
            hasSkills: Boolean(skillInstructions),
            runtimeProfile: runtime.runtimeProfileSlug,
        });

        // 6. gRPC target already resolved by the caller via resolveRuntimeProfile()
        //    + resolveRuntimeTarget() (pre-FASE-7 callers fall back to the
        //    default runtime above which points at the OpenClaude socket/host).
        const target: RuntimeTarget = runtime.target;
        const timeoutMs = parseInt(process.env.OPENCLAUDE_TIMEOUT_MS || '300000', 10);

        // 6.5. FASE 11: circuit breaker — reject if too many recent failures
        let circuitHandle;
        try {
            circuitHandle = beforeCircuitCall(`runtime:${runtime.runtimeProfileSlug}`);
        } catch (err) {
            if (err instanceof CircuitOpenError) {
                // Mark blocked, surface clear error, don't even try the gRPC call
                await client.query(
                    `UPDATE architect_work_items
                     SET status = 'blocked',
                         dispatch_error = $2,
                         last_event_at = NOW()
                     WHERE id = $1`,
                    [workItemId, `Circuit breaker open — runtime ${runtime.runtimeProfileSlug} degraded. Retry in ~30s.`]
                );
                return {
                    success: false,
                    output: {},
                    error: `Circuit open for runtime ${runtime.runtimeProfileSlug}`,
                };
            }
            throw err;
        }

        // 7. Create per-(org, work_item) workspace under the shared volume
        workspacePath = createWorkspace(orgId, workItemId);

        // 8. Execute via gRPC (non-blocking handle)
        const handle = executeOpenClaudeRun({
            host: target.host,
            socketPath: target.socketPath,
            message: instruction,
            workingDirectory: workspacePath,
            sessionId,
            timeoutMs,
        });
        const { emitter, respond, cancel } = handle;

        // 9. Register the live stream so the worker can cancel/respond from
        // separate BullMQ jobs (cancel-run, resolve-approval).
        registerStream(workItemId, { cancel, respond });
        streamRegistered = true;

        // 10. Collect events and await completion
        const toolEvents: Array<{ name: string; output?: string; error?: boolean }> = [];
        let fullText = '';
        let promptTokens = 0;
        let completionTokens = 0;

        const result = await new Promise<AdapterResult>((resolvePromise) => {

            emitter.on('text_chunk', (data: any) => {
                fullText += data.text || '';
            });

            emitter.on('tool_start', async (data: any) => {
                await recordEvidence(pool, {
                    orgId,
                    category: 'data_access',
                    eventType: 'OPENCLAUDE_TOOL_START',
                    resourceType: 'architect_work_item',
                    resourceId: workItemId,
                    metadata: { tool: data.tool_name, toolUseId: data.tool_use_id, sessionId },
                }).catch(() => {});
                await insertWorkItemEvent(pool, orgId, workItemId, 'TOOL_START', {
                    args: data.arguments_json, toolUseId: data.tool_use_id,
                }, data.tool_name);
            });

            emitter.on('tool_result', async (data: any) => {
                toolEvents.push({
                    name: data.tool_name,
                    output: typeof data.output === 'string' ? data.output.substring(0, 500) : undefined,
                    error: Boolean(data.is_error),
                });
                await recordEvidence(pool, {
                    orgId,
                    category: 'data_access',
                    eventType: 'OPENCLAUDE_TOOL_RESULT',
                    resourceType: 'architect_work_item',
                    resourceId: workItemId,
                    metadata: {
                        tool: data.tool_name,
                        toolUseId: data.tool_use_id,
                        isError: Boolean(data.is_error),
                        outputLength: data.output?.length || 0,
                        sessionId,
                    },
                }).catch(() => {});
                await insertWorkItemEvent(pool, orgId, workItemId, 'TOOL_RESULT', {
                    output: typeof data.output === 'string' ? data.output.substring(0, 500) : null,
                    isError: Boolean(data.is_error),
                    toolUseId: data.tool_use_id,
                }, data.tool_name);
            });

            // FASE 5-hardening: replaced auto-approval with grant resolution.
            // Safe tools auto-allowed, dangerous tools → human approval bridge.
            //
            // FASE 6c: before falling into the classifier, check whether the
            // user already opted the entire work item into an auto-approve
            // mode via POST /approve-action (approve_mode=auto_all|auto_safe).
            // This is what prevents the approval-fatigue loop on real agent
            // runs that chain 10-30 tool calls.
            emitter.on('action_required', async (data: any) => {
                const toolName = parseToolNameFromQuestion(data.question);

                // ─────────────────────────────────────────────────────────
                // FASE 13.5a — shield_level gate
                //
                // Shield levels 1 (Fluxo Livre) and 2 (Conformidade) run
                // runtime tool use NATIVELY. The runtime's own tool-use
                // dialog IS the authorization; GovAI records the event
                // for audit and releases the prompt immediately.
                //
                // Shield level 3 (Blindagem Máxima) preserves the full
                // pre-13.5a pipeline below: approval_mode → auto_safe →
                // resolveToolDecision → awaiting_approval / allow / deny.
                //
                // Invariant guarded by `requiresHitlForTool`: only
                // level === 3 engages the classifier. Everything below
                // this block runs unchanged for level 3 callers.
                // ─────────────────────────────────────────────────────────
                if (!requiresHitlForTool(shieldLevel)) {
                    respond(data.prompt_id, 'yes');
                    await recordEvidence(pool, {
                        orgId,
                        category: 'data_access',
                        eventType: 'TOOL_NATIVE_RUNTIME_USE',
                        resourceType: 'architect_work_item',
                        resourceId: workItemId,
                        metadata: {
                            tool: toolName,
                            promptId: data.prompt_id,
                            sessionId,
                            shield_level: shieldLevel,
                            reason: 'shield_level_below_3_native_flow',
                        },
                    }).catch(() => { /* non-fatal */ });
                    await insertWorkItemEvent(pool, orgId, workItemId, 'ACTION_RESPONSE', {
                        decision: 'allow',
                        reason: `native_runtime_shield_level_${shieldLevel}`,
                        automatic: true,
                    }, toolName, data.prompt_id);
                    return;
                }

                // 1. Read the current approval_mode (persisted by the route
                //    and/or the resolve-approval worker job).
                //    IMPORTANT: architect_work_items has RLS; use a dedicated
                //    client with set_config so the SELECT can see the row.
                //    Using `pool.query` directly hits a fresh unset session
                //    and returns zero rows silently.
                let approvalMode: string | null = null;
                try {
                    const modeClient = await pool.connect();
                    try {
                        await modeClient.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                        const modeRes = await modeClient.query(
                            `SELECT execution_context->>'approval_mode' AS mode
                             FROM architect_work_items WHERE id = $1 AND org_id = $2`,
                            [workItemId, orgId]
                        );
                        approvalMode = modeRes.rows[0]?.mode ?? null;
                    } finally {
                        await modeClient.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                        modeClient.release();
                    }
                } catch { /* best-effort */ }

                // 2. auto_all — user approved everything up front. Skip the
                //    classifier and immediately respond 'yes'.
                if (approvalMode === 'auto_all') {
                    respond(data.prompt_id, 'yes');
                    await recordEvidence(pool, {
                        orgId,
                        category: 'approval',
                        eventType: 'TOOL_AUTO_APPROVED_BY_USER',
                        resourceType: 'architect_work_item',
                        resourceId: workItemId,
                        metadata: {
                            tool: toolName, promptId: data.prompt_id,
                            mode: 'auto_all', sessionId,
                        },
                    }).catch(() => {});
                    await insertWorkItemEvent(pool, orgId, workItemId, 'ACTION_RESPONSE', {
                        decision: 'allow',
                        reason: 'user_approved_all',
                        automatic: true,
                    }, toolName, data.prompt_id);
                    return;
                }

                // 3. auto_safe — allow read-only tools without prompting;
                //    mutating tools still fall through to requires_approval.
                if (approvalMode === 'auto_safe' && SAFE_READ_ONLY_TOOLS.has(toolName)) {
                    respond(data.prompt_id, 'yes');
                    await recordEvidence(pool, {
                        orgId,
                        category: 'approval',
                        eventType: 'TOOL_AUTO_APPROVED_BY_USER',
                        resourceType: 'architect_work_item',
                        resourceId: workItemId,
                        metadata: {
                            tool: toolName, promptId: data.prompt_id,
                            mode: 'auto_safe', sessionId,
                        },
                    }).catch(() => {});
                    await insertWorkItemEvent(pool, orgId, workItemId, 'ACTION_RESPONSE', {
                        decision: 'allow',
                        reason: 'user_approved_safe_read',
                        automatic: true,
                    }, toolName, data.prompt_id);
                    return;
                }

                const decision = await resolveToolDecision(pool, orgId, workItemId, toolName);

                if (decision.action === 'allow') {
                    respond(data.prompt_id, 'yes');
                    await recordEvidence(pool, {
                        orgId,
                        category: 'data_access',
                        eventType: 'TOOL_ALLOWED_BY_GRANT',
                        resourceType: 'architect_work_item',
                        resourceId: workItemId,
                        metadata: { tool: toolName, promptId: data.prompt_id, reason: decision.reason, sessionId },
                    }).catch(() => {});
                    await insertWorkItemEvent(pool, orgId, workItemId, 'ACTION_RESPONSE', {
                        decision: 'allow', reason: decision.reason, automatic: true,
                    }, toolName, data.prompt_id);
                    return;
                }

                if (decision.action === 'deny') {
                    respond(data.prompt_id, 'no');
                    await recordEvidence(pool, {
                        orgId,
                        category: 'policy_enforcement',
                        eventType: 'TOOL_DENIED_BY_POLICY',
                        resourceType: 'architect_work_item',
                        resourceId: workItemId,
                        metadata: { tool: toolName, promptId: data.prompt_id, reason: decision.reason, sessionId },
                    }).catch(() => {});
                    await insertWorkItemEvent(pool, orgId, workItemId, 'ACTION_RESPONSE', {
                        decision: 'deny', reason: decision.reason, automatic: true,
                    }, toolName, data.prompt_id);
                    return;
                }

                // requires_approval — suspend the stream and flip the work item state.
                // The stream stays open; the worker will call respond() when the human
                // resolves the approval via POST /approve-action → resolve-approval job.
                const cl = await pool.connect();
                try {
                    await cl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    await cl.query(
                        `UPDATE architect_work_items SET status = 'awaiting_approval' WHERE id = $1 AND org_id = $2`,
                        [workItemId, orgId]
                    );
                } catch (e) {
                    console.warn('[OpenClaude] failed to flip awaiting_approval:', (e as Error).message);
                } finally {
                    await cl.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                    cl.release();
                }

                await recordEvidence(pool, {
                    orgId,
                    category: 'approval',
                    eventType: 'TOOL_AWAITING_APPROVAL',
                    resourceType: 'architect_work_item',
                    resourceId: workItemId,
                    metadata: { tool: toolName, promptId: data.prompt_id, question: data.question, sessionId },
                }).catch(() => {});
                await insertWorkItemEvent(pool, orgId, workItemId, 'ACTION_REQUIRED', {
                    question: data.question, type: data.type,
                }, toolName, data.prompt_id);
            });

            emitter.on('done', async (data: any) => {
                // FASE 11: record circuit breaker success
                try { circuitHandle.recordSuccess(); } catch { /* ignore */ }
                // FASE 12: track billable Claude Code calls for cost visibility
                if (runtime.runtimeProfileSlug === 'claude_code_official') {
                    try {
                        const { recordClaudeCodeBillableCall } = require('./sre-metrics');
                        recordClaudeCodeBillableCall('success');
                    } catch { /* ignore */ }
                }

                fullText = data.full_text || fullText;
                promptTokens = data.prompt_tokens || 0;
                completionTokens = data.completion_tokens || 0;

                const cl = await pool.connect();
                try {
                    await cl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    // FASE 6c-fix: merge with current DB state (not the stale `ctx`
                    // snapshot) so mid-flight writes — like approval_mode set by
                    // the approve-action route — are preserved at the terminal
                    // state. The `||` operator shallow-merges JSONB, our payload
                    // overwrites adapter/output/tokens but keeps approval_mode,
                    // assistantId, delegated_from, matchedPattern, etc.
                    await cl.query(
                        `UPDATE architect_work_items
                         SET status = 'done', completed_at = now(), last_event_at = now(),
                             execution_context = COALESCE(execution_context, '{}'::jsonb) || $1::jsonb
                         WHERE id = $2`,
                        [
                            JSON.stringify({
                                adapter: 'openclaude',
                                sessionId,
                                input: { instruction: instruction.substring(0, 500) },
                                output: {
                                    fullText: fullText.substring(0, 2000),
                                    toolEvents,
                                },
                                tokens: { prompt: promptTokens, completion: completionTokens },
                            }),
                            workItemId,
                        ]
                    );
                } finally {
                    await cl.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                    cl.release();
                }

                await recordEvidence(pool, {
                    orgId,
                    category: 'data_access',
                    eventType: 'OPENCLAUDE_RUN_COMPLETED',
                    resourceType: 'architect_work_item',
                    resourceId: workItemId,
                    metadata: { sessionId, promptTokens, completionTokens, toolCount: toolEvents.length },
                }).catch(() => {});
                await insertWorkItemEvent(pool, orgId, workItemId, 'RUN_COMPLETED', {
                    promptTokens, completionTokens, toolCount: toolEvents.length,
                });

                resolvePromise({
                    success: true,
                    output: {
                        fullText: fullText.substring(0, 5000),
                        toolEvents,
                        tokens: { prompt: promptTokens, completion: completionTokens },
                    },
                });
            });

            emitter.on('error', async (data: any) => {
                // FASE 11: record circuit breaker failure
                try { circuitHandle.recordFailure(); } catch { /* ignore */ }
                // FASE 12: track billable Claude Code failures
                if (runtime.runtimeProfileSlug === 'claude_code_official') {
                    try {
                        const { recordClaudeCodeBillableCall } = require('./sre-metrics');
                        recordClaudeCodeBillableCall('failure');
                    } catch { /* ignore */ }
                }

                const errorMsg = data.message || 'OpenClaude execution failed';

                const cl = await pool.connect();
                try {
                    await cl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    await cl.query(
                        `UPDATE architect_work_items
                         SET dispatch_error = $1, last_event_at = now(),
                             status = CASE
                                 WHEN cancellation_requested_at IS NOT NULL THEN 'cancelled'
                                 WHEN dispatch_attempts >= 3 THEN 'blocked'
                                 ELSE 'pending'
                             END,
                             cancelled_at = CASE
                                 WHEN cancellation_requested_at IS NOT NULL THEN now()
                                 ELSE cancelled_at
                             END
                         WHERE id = $2`,
                        [errorMsg, workItemId]
                    );
                } finally {
                    await cl.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                    cl.release();
                }

                await recordEvidence(pool, {
                    orgId,
                    category: 'data_access',
                    eventType: 'OPENCLAUDE_RUN_FAILED',
                    resourceType: 'architect_work_item',
                    resourceId: workItemId,
                    metadata: { sessionId, error: errorMsg, code: data.code },
                }).catch(() => {});
                await insertWorkItemEvent(pool, orgId, workItemId, 'RUN_FAILED', {
                    error: errorMsg, code: data.code,
                });

                resolvePromise({ success: false, output: {}, error: errorMsg });
            });

            // Fallback: stream ended without done/error
            emitter.on('end', () => {
                if (fullText) {
                    resolvePromise({
                        success: true,
                        output: { fullText: fullText.substring(0, 5000), toolEvents },
                    });
                } else {
                    resolvePromise({
                        success: false,
                        output: {},
                        error: 'gRPC stream ended without response',
                    });
                }
            });
        });

        return result;

    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        try {
            await client.query(
                `UPDATE architect_work_items
                 SET dispatch_error = $1,
                     dispatch_attempts = dispatch_attempts + 1,
                     status = CASE WHEN dispatch_attempts + 1 >= 3 THEN 'blocked' ELSE 'pending' END
                 WHERE id = $2 AND org_id = $3`,
                [errorMsg, workItemId, orgId]
            );
        } catch { /* non-fatal */ }
        return { success: false, output: {}, error: errorMsg };
    } finally {
        if (streamRegistered) {
            unregisterStream(workItemId);
        }
        if (workspacePath) {
            cleanupWorkspace(workspacePath);
        }
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Delegation Router ─────────────────────────────────────────────────────────

export async function dispatchWorkItem(
    pool: Pool,
    orgId: string,
    workItemId: string
): Promise<DispatchResult> {
    const client = await pool.connect();
    // eslint-disable-next-line prefer-const
    let item!: Record<string, unknown>;
    let guardOutcome: 'proceed' | 'locked' | 'terminal' | 'blocked' = 'proceed';

    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        await client.query('BEGIN');

        // 1. Lock with SKIP LOCKED — concurrent callers skip rather than block
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items
             WHERE id = $1 AND org_id = $2
             FOR UPDATE SKIP LOCKED`,
            [workItemId, orgId]
        );

        if (wiRes.rows.length === 0) {
            // Another worker holds the lock
            guardOutcome = 'locked';
            await client.query('ROLLBACK').catch(() => {});
        } else {
            item = wiRes.rows[0];

            // 2. Check terminal status
            if (item.status === 'done' || item.status === 'cancelled') {
                guardOutcome = 'terminal';
                await client.query('ROLLBACK').catch(() => {});
            } else if ((item.dispatch_attempts as number) >= 3) {
                // 3. Check max attempts
                await client.query(
                    `UPDATE architect_work_items SET status = 'blocked' WHERE id = $1`,
                    [workItemId]
                );
                guardOutcome = 'blocked';
                await client.query('COMMIT').catch(() => {});
            } else {
                // Guard passed — commit and proceed to adapter
                await client.query('COMMIT').catch(() => {});
            }
        }
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
        throw err;
    }

    await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
    client.release();

    // 4. Handle guard outcomes
    if (guardOutcome === 'locked') {
        return {
            workItemId,
            adapter: 'locked',
            success: false,
            output: {},
            error: 'Work item locked by concurrent dispatch',
        };
    }
    if (guardOutcome === 'terminal') {
        throw new Error('Work item already terminal');
    }
    if (guardOutcome === 'blocked') {
        throw new Error('Max dispatch attempts reached');
    }

    // 5. Route by execution_hint (adapter opens its own connection).
    //
    // FASE 7: both 'openclaude' and 'claude_code' hints flow through the
    // unified gRPC runtime adapter. The runtime profile is resolved here
    // (priority: explicit slug on the work item → assistant default →
    // system default → hard-coded 'openclaude' fallback) and the resolved
    // { target, slug, claim_level } is passed down so the adapter talks to
    // the right container without any adapter-side routing code.
    const hint = item.execution_hint as string | null;
    const existingSlug = (item.runtime_profile_slug as string | null) ?? null;

    let adapterName: string;
    let result: AdapterResult;

    if (hint === 'internal_rag') {
        adapterName = 'internal_rag';
        result = await runInternalRagAdapter(pool, orgId, workItemId);
    } else if (hint === 'agno') {
        adapterName = 'agno';
        result = await runAgnoAdapter(pool, orgId, workItemId);
    } else if (hint === 'human') {
        adapterName = 'human';
        result = await runHumanAdapter(pool, orgId, workItemId);
    } else if (hint === 'openclaude' || hint === 'claude_code') {
        // Figure out which runtime slug to use. Priority:
        //   1. runtime_profile_slug already persisted on the work item
        //      (set by the chat wrapper or the resolve-approval path).
        //   2. For hint='claude_code' default to 'claude_code_official'.
        //   3. Otherwise 'openclaude'.
        const explicitSlug = existingSlug
            || (hint === 'claude_code' ? 'claude_code_official' : 'openclaude');
        const ctxAssistantId = ((item.execution_context as Record<string, unknown> | null)?.assistant_id
            ?? (item.execution_context as Record<string, unknown> | null)?.assistantId) as string | undefined;

        let runtimeCtx: RuntimeAdapterContext;
        try {
            // FASE 8: use the 5-layer resolver (explicit → case → template
            // → assistant → tenant → global) with cached availability checks.
            const resolution = await resolveRuntimeForExecution(pool, orgId, {
                explicitSlug,
                assistantId: ctxAssistantId,
            });
            runtimeCtx = {
                runtimeProfileSlug: resolution.profile.slug,
                target: resolveRuntimeTarget(resolution.profile),
                claimLevel: resolution.claim_level,
            };

            // FASE 8: persist claim_level + source on the work item at dispatch
            // so every run's governance claim is frozen at execution time.
            const persistCl = await pool.connect();
            try {
                await persistCl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                await persistCl.query(
                    `UPDATE architect_work_items
                     SET runtime_claim_level = $1,
                         execution_context = COALESCE(execution_context, '{}'::jsonb) || $2::jsonb
                     WHERE id = $3 AND org_id = $4`,
                    [
                        resolution.claim_level,
                        JSON.stringify({
                            runtime_source: resolution.source,
                            runtime_fallback_applied: resolution.fallbackApplied ?? false,
                        }),
                        workItemId,
                        orgId,
                    ]
                );
            } finally {
                await persistCl.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                persistCl.release();
            }
        } catch (e) {
            // FIX 3 (FASE 7-fix): when the user explicitly requested a
            // runtime that isn't available, we do NOT silently fallback.
            // The work item is marked 'blocked' with a clear error so the
            // UI can render it and the user knows to either start the
            // container or pick a different runtime.
            if (e instanceof RuntimeUnavailableError) {
                const cl = await pool.connect();
                try {
                    await cl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    await cl.query(
                        `UPDATE architect_work_items
                         SET status = 'blocked', dispatch_error = $1
                         WHERE id = $2 AND org_id = $3`,
                        [e.message, workItemId, orgId]
                    );
                } finally {
                    await cl.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                    cl.release();
                }
                return {
                    workItemId,
                    adapter: e.runtimeSlug,
                    success: false,
                    output: {},
                    error: e.message,
                };
            }
            // Other resolution errors (missing seed, DB issue) still
            // fallback to OpenClaude so the platform degrades gracefully.
            console.warn('[Architect] runtime resolution failed, falling back to openclaude defaults:', (e as Error).message);
            runtimeCtx = {
                runtimeProfileSlug: 'openclaude',
                target: resolveOpenClaudeTarget(),
                claimLevel: 'open_governed',
            };
        }
        adapterName = runtimeCtx.runtimeProfileSlug;
        result = await runOpenClaudeAdapter(pool, orgId, workItemId, runtimeCtx);
    } else {
        // No hint or unknown — default to human adapter
        adapterName = 'human';
        result = await runHumanAdapter(pool, orgId, workItemId);
    }

    // 6. Return dispatch result
    return {
        workItemId,
        adapter: adapterName,
        success: result.success,
        output: result.output,
        error: result.error,
    };
}

// ── Batch Dispatch ────────────────────────────────────────────────────────────

export async function dispatchPendingWorkItems(
    pool: Pool,
    orgId: string,
    workflowGraphId: string
): Promise<DispatchResult[]> {
    const client = await pool.connect();
    let pendingIds: string[];
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `SELECT id FROM architect_work_items
             WHERE workflow_graph_id = $1 AND org_id = $2 AND status = 'pending'
             ORDER BY created_at ASC`,
            [workflowGraphId, orgId]
        );
        pendingIds = res.rows.map(r => r.id as string);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }

    // Dispatch sequentially to avoid race conditions
    const results: DispatchResult[] = [];
    for (const workItemId of pendingIds) {
        try {
            const result = await dispatchWorkItem(pool, orgId, workItemId);
            // Skip silently if another process has the lock
            if (result.error?.includes('locked')) continue;
            results.push(result);
        } catch (err: unknown) {
            results.push({
                workItemId,
                adapter: 'unknown',
                success: false,
                output: {},
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return results;
}

// ── FASE 11 — Stuck work item watchdog ──────────────────────────────────

/**
 * Detects and marks stuck work items as blocked.
 *
 * A work item is considered stuck if:
 *   - status is 'in_progress' or 'awaiting_approval'
 *   - last_event_at (or run_started_at / created_at as fallback) is older
 *     than ARCHITECT_STUCK_THRESHOLD_MIN (default 15 minutes)
 *
 * Called periodically by the architect worker (every 5 min by default).
 * Operators see `dispatch_error` with a clear "Stuck for N minutes" message
 * and can retry the work item manually.
 *
 * Returns the number of items marked blocked in this sweep.
 */
export async function detectAndMarkStuckWorkItems(pool: Pool): Promise<number> {
    const thresholdMin = parseInt(process.env.ARCHITECT_STUCK_THRESHOLD_MIN || '15', 10);
    const client = await pool.connect();
    let marked = 0;
    try {
        // Query WITHOUT set_config (we need a cross-org sweep). This is safe
        // because we only SELECT + UPDATE by primary key on our own schema;
        // no user data leaks. The UPDATE below re-sets set_config per-org to
        // satisfy RLS on the actual write.
        const res = await client.query(`
            SELECT id, org_id,
                   EXTRACT(EPOCH FROM (NOW() - COALESCE(last_event_at, run_started_at, created_at))) / 60 AS minutes_idle
            FROM architect_work_items
            WHERE status IN ('in_progress', 'awaiting_approval')
              AND COALESCE(last_event_at, run_started_at, created_at) < NOW() - INTERVAL '1 minute' * $1
            ORDER BY created_at ASC
            LIMIT 20
        `, [thresholdMin]);

        for (const row of res.rows) {
            try {
                await client.query("SELECT set_config('app.current_org_id', $1, false)", [row.org_id]);
                const mins = Math.floor(row.minutes_idle);
                const upd = await client.query(`
                    UPDATE architect_work_items
                    SET status = 'blocked',
                        dispatch_error = $3,
                        last_event_at = NOW()
                    WHERE id = $1 AND org_id = $2 AND status IN ('in_progress', 'awaiting_approval')
                `, [row.id, row.org_id, `Stuck for ${mins} minutes — watchdog marked blocked`]);
                if (upd.rowCount && upd.rowCount > 0) marked++;
            } catch (err) {
                console.warn(`[Architect Watchdog] failed to mark ${row.id} blocked:`, (err as Error).message);
            }
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
    return marked;
}

/**
 * FASE 13.5a1: recover orphaned PENDING work items.
 *
 * When a dispatch job is dropped by BullMQ (e.g., retries exhausted against
 * a busy tenant slot), the work_item is left in `status='pending'` AND
 * `dispatch_attempts=0` with no live queue entry. This sweep:
 *   1. finds items older than `orphanThresholdMin` (default 5) that look
 *      like orphans
 *   2. checks BullMQ — if a job for this work_item is still in flight
 *      (wait/active/delayed), skips it (the worker is handling it)
 *   3. otherwise re-enqueues the dispatch and bumps `recovery_attempts`
 *   4. items that burn through `maxRecoveryAttempts` (default 3) are
 *      marked `status='blocked'` with `dispatch_error='watchdog_recovery_exhausted'`
 *
 * The caller injects the architect queue (instead of importing it here) to
 * avoid a cyclic import between architect-delegation ↔ workers/architect.
 */
export async function recoverOrphanedPendingWorkItems(
    pool: Pool,
    queue: { add: (name: string, data: any, opts: any) => Promise<unknown>; getJobs: (types: string[], start: number, end: number, asc: boolean) => Promise<Array<{ data?: any }>> },
): Promise<{ recovered: number; blocked: number }> {
    const orphanThresholdMin = parseInt(process.env.ARCHITECT_ORPHAN_THRESHOLD_MIN || '5', 10);
    const maxRecoveryAttempts = parseInt(process.env.ARCHITECT_MAX_RECOVERY_ATTEMPTS || '3', 10);
    const client = await pool.connect();
    let recovered = 0;
    let blocked = 0;

    try {
        // Cross-org sweep — same RLS-bypass pattern as
        // detectAndMarkStuckWorkItems. Reads are by id only, writes re-set
        // app.current_org_id per-row.
        const candidates = await client.query(`
            SELECT id, org_id, recovery_attempts
              FROM architect_work_items
             WHERE status = 'pending'
               AND dispatch_attempts = 0
               AND recovery_attempts < $2
               AND created_at < NOW() - INTERVAL '1 minute' * $1
          ORDER BY created_at ASC
             LIMIT 20
        `, [orphanThresholdMin, maxRecoveryAttempts]);

        if (candidates.rowCount && candidates.rowCount > 0) {
            // Pull live jobs once; avoid N queries against Redis.
            let liveJobWorkItemIds = new Set<string>();
            try {
                const jobs = await queue.getJobs(['wait', 'active', 'delayed'], 0, -1, true);
                liveJobWorkItemIds = new Set(
                    jobs
                        .map(j => (j?.data as any)?.workItemId)
                        .filter((v): v is string => typeof v === 'string'),
                );
            } catch (err) {
                console.warn(
                    '[Architect Watchdog] failed to list BullMQ jobs — ' +
                    'will re-enqueue candidates without dedupe:',
                    (err as Error).message,
                );
            }

            for (const row of candidates.rows) {
                if (liveJobWorkItemIds.has(row.id)) {
                    continue; // worker already handling
                }
                try {
                    await client.query("SELECT set_config('app.current_org_id', $1, false)", [row.org_id]);
                    const nextAttempt = Number(row.recovery_attempts) + 1;
                    await client.query(
                        `UPDATE architect_work_items
                            SET recovery_attempts = recovery_attempts + 1,
                                last_event_at = NOW()
                          WHERE id = $1 AND org_id = $2
                            AND status = 'pending' AND dispatch_attempts = 0`,
                        [row.id, row.org_id],
                    );
                    await queue.add(
                        'dispatch-openclaude',
                        { workItemId: row.id, orgId: row.org_id },
                        {
                            attempts: 1,
                            jobId: `${row.id}-recovery-${nextAttempt}`,
                            removeOnComplete: true,
                            removeOnFail: { age: 3600, count: 100 },
                        },
                    );
                    console.warn(
                        `[Architect Watchdog] recovered orphaned work_item ${row.id} ` +
                        `(attempt ${nextAttempt}/${maxRecoveryAttempts})`,
                    );
                    recovered++;
                } catch (err) {
                    console.warn(
                        `[Architect Watchdog] recovery failed for ${row.id}:`,
                        (err as Error).message,
                    );
                }
            }
        }

        // Items that have exhausted the recovery budget AND still look
        // orphaned: mark blocked so they stop trapping the sweep.
        const exhausted = await client.query(`
            UPDATE architect_work_items
               SET status = 'blocked',
                   dispatch_error = COALESCE(dispatch_error, 'watchdog_recovery_exhausted'),
                   last_event_at = NOW()
             WHERE status = 'pending'
               AND dispatch_attempts = 0
               AND recovery_attempts >= $1
               AND created_at < NOW() - INTERVAL '30 minutes'
        `, [maxRecoveryAttempts]);
        blocked = exhausted.rowCount ?? 0;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
    return { recovered, blocked };
}
