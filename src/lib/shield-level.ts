/**
 * Shield Level — FASE 13.5a
 * ---------------------------------------------------------------------------
 * Centralized governance gate. Three levels of increasing intervention,
 * selectable per organization (and optionally overridable upward per
 * assistant):
 *
 *   1 (Fluxo Livre, DEFAULT)  DLP + audit + cost caps. No approval gates.
 *                             Runtimes (Claude Code, OpenClaude) run natively —
 *                             their own tool-use dialog IS the accepted
 *                             authorization. GovAI records what happened,
 *                             does not pause execution.
 *   2 (Conformidade)          Level 1 + segregation of duties on formal
 *                             actions (policy publish, risk assessment,
 *                             security exceptions). Runtime tool use still
 *                             flows natively.
 *   3 (Blindagem Máxima)      Level 2 + tool-use classification and HITL on
 *                             destructive tools. This is the behaviour
 *                             shipped before 13.5a.
 *
 * Consumers call `requiresApproval(action, level)` rather than checking
 * the numeric level directly so the mapping lives in one place. See
 * docs/ASSURANCE_MODES.md for the full decision matrix.
 */

import type { Pool } from 'pg';

export type ShieldLevel = 1 | 2 | 3;

export type GovernedAction =
    | 'tool_use_destructive'   // L3 only — runtime tool use that mutates/executes
    | 'policy_publish'         // L2+ — publishing a new policy version
    | 'risk_assessment'        // L2+ — formalizing a risk assessment decision
    | 'security_exception'     // L2+ — requesting a security exception
    | 'exception_approval';    // L2+ — approving a pending exception

export function isShieldLevel(v: unknown): v is ShieldLevel {
    return v === 1 || v === 2 || v === 3;
}

/**
 * Single source of truth for "does this action require SoD / HITL at this
 * shield level". Keep the matrix inlined (and explicit) so an auditor can
 * read the file and verify the control set without running the service.
 */
export function requiresApproval(action: GovernedAction, level: ShieldLevel): boolean {
    // Level 1: no gate on anything.
    if (level === 1) return false;
    // Level 2: SoD on formal actions, but NOT on runtime tool use.
    if (level === 2) return action !== 'tool_use_destructive';
    // Level 3: gate on every governed action.
    return true;
}

/**
 * Convenience alias for the hot path (OpenClaude/Claude Code adapter).
 */
export function requiresHitlForTool(level: ShieldLevel): boolean {
    return requiresApproval('tool_use_destructive', level);
}

/**
 * Resolve the effective shield level for an execution context.
 *
 * Precedence:
 *   assistant.shield_level (if set and found) > organization.shield_level
 *
 * The DB trigger `enforce_assistant_shield_level_gte_org` guarantees
 * `assistant.shield_level >= org.shield_level`, so in practice the
 * resolved level is `max(assistant, org)` — we just read the explicit
 * override when present.
 *
 * Fail-open: if the query fails or returns an invalid value, we return
 * the safest default (level 1). The alternative — throwing here — would
 * cascade into every adapter / route and could kill a legitimate
 * request. The audit trail still records what level WAS applied.
 */
export async function resolveShieldLevel(
    pool: Pool,
    orgId: string,
    assistantId?: string | null,
): Promise<ShieldLevel> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        if (assistantId) {
            const r = await client.query(
                `SELECT COALESCE(a.shield_level, o.shield_level) AS level
                   FROM assistants a
                   JOIN organizations o ON o.id = a.org_id
                  WHERE a.id = $1 AND a.org_id = $2`,
                [assistantId, orgId],
            );
            if (r.rows.length > 0 && isShieldLevel(r.rows[0].level)) {
                return r.rows[0].level;
            }
        }

        const r = await client.query(
            'SELECT shield_level FROM organizations WHERE id = $1',
            [orgId],
        );
        const level = r.rows[0]?.shield_level;
        if (isShieldLevel(level)) return level;
        return 1;
    } catch {
        // Fail-open to least restrictive. The caller's audit log still
        // captures what level was applied via recordEvidence().
        return 1;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
