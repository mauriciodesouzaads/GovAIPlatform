/**
 * FinOps Quota Enforcement Middleware
 * 
 * Checks token consumption against org-level Hard/Soft caps
 * before allowing execution to proceed.
 * 
 * - Hard Cap exceeded → 429 (block execution)
 * - Soft Cap exceeded → 200 but X-GovAI-Quota-Warning header
 */
import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';

export interface QuotaStatus {
    tokens_used: number;
    soft_cap: number;
    hard_cap: number;
    percentage: number;
    exceeded: boolean;
    warning: boolean;
}

export async function checkQuota(
    pgPool: Pool,
    orgId: string,
    assistantId?: string
): Promise<QuotaStatus> {
    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

        // Fetch the most specific quota (assistant > org)
        const quotaRes = await client.query(`
            SELECT soft_cap_tokens, hard_cap_tokens, tokens_used
            FROM billing_quotas
            WHERE org_id = $1
            AND (scope_id = $2 OR scope = 'organization')
            ORDER BY CASE WHEN scope_id IS NOT NULL THEN 0 ELSE 1 END
            LIMIT 1
        `, [orgId, assistantId || null]);

        if (quotaRes.rows.length === 0) {
            // No quota configured = unlimited
            return { tokens_used: 0, soft_cap: Infinity, hard_cap: Infinity, percentage: 0, exceeded: false, warning: false };
        }

        const { soft_cap_tokens, hard_cap_tokens, tokens_used } = quotaRes.rows[0];
        const percentage = hard_cap_tokens > 0 ? Math.round((tokens_used / hard_cap_tokens) * 100) : 0;

        return {
            tokens_used: parseInt(tokens_used),
            soft_cap: parseInt(soft_cap_tokens),
            hard_cap: parseInt(hard_cap_tokens),
            percentage,
            exceeded: tokens_used >= hard_cap_tokens,
            warning: tokens_used >= soft_cap_tokens && tokens_used < hard_cap_tokens,
        };
    } finally {
        client.release();
    }
}

export async function recordTokenUsage(
    pgPool: Pool,
    orgId: string,
    assistantId: string,
    tokensPrompt: number,
    tokensCompletion: number,
    costUsd: number,
    traceId: string
): Promise<void> {
    const total = tokensPrompt + tokensCompletion;
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

        // 1. Insert into ledger
        await client.query(
            `INSERT INTO token_usage_ledger (org_id, assistant_id, tokens_prompt, tokens_completion, tokens_total, cost_usd, trace_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orgId, assistantId, tokensPrompt, tokensCompletion, total, costUsd, traceId]
        );

        // 2. Increment quota usage atomically
        await client.query(
            `UPDATE billing_quotas SET tokens_used = tokens_used + $1, updated_at = NOW()
             WHERE org_id = $2 AND (scope_id = $3 OR scope = 'organization')`,
            [total, orgId, assistantId]
        );

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

export function getCostPerToken(model: string): number {
    const pricing: Record<string, number> = {
        'gemini/gemini-1.5-flash': 0.000000019,
        'gemini/gemini-1.5-pro': 0.000000350,
        'openai/gpt-4o': 0.000005000,
        'openai/gpt-4o-mini': 0.000000150,
        'anthropic/claude-3-5-sonnet': 0.000003000,
        'anthropic/claude-3-haiku': 0.000000250,
    };
    for (const [key, cost] of Object.entries(pricing)) {
        if (model.includes(key.split('/')[1])) return cost;
    }
    return 0.000002;
}
