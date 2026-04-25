import { z } from 'zod';
import { FastifyRequest } from 'fastify';
import crypto from 'crypto';

export const ActionType = z.enum([
    'EXECUTION',
    'POLICY_VIOLATION',
    'EXECUTION_SUCCESS',
    'EXECUTION_ERROR',
    'PENDING_APPROVAL',
    'APPROVAL_GRANTED',
    'APPROVAL_REJECTED',
    'QUOTA_EXCEEDED',
    'TELEMETRY_CONSENT_GRANTED',
    'TELEMETRY_CONSENT_REVOKED',
    'EXIT_GOVERNED_PERIMETER',
    'TOOL_CALL_SUCCESS',
    'TOOL_CALL_BLOCKED',
    'TOOL_CALL_FAILED',
]);
export type ActionType = z.infer<typeof ActionType>;

export const GovernanceRequestSchema = z.object({
    message: z.string().min(1, "O input não pode estar vazio").max(10000, "O input excede o limite máximo permitido"),
    model: z.string().optional(),
    // FASE 7: optional runtime selection. Ignored for non-delegated runs.
    // Valid slugs live in runtime_profiles (seeded: 'openclaude',
    // 'claude_code_official'). Any other value is passed through and
    // the resolver will fall back to the system default if unknown.
    runtime_profile: z.string().min(1).max(100).optional(),
    // FASE 14.0/3a — runtime-specific knobs propagated to the runner.
    // All optional. Today only claude-code-runner reads them; the other
    // runners ignore unknown fields harmlessly.
    runtime_options: z.object({
        // Resume an existing CLI session by ID (continues conversation).
        resume_session_id: z.string().min(1).max(128).optional(),
        // Enable extended thinking for the underlying model.
        enable_thinking: z.boolean().optional(),
        // Hint for thinking budget; runner maps to the closest CLI
        // effort tier (low/medium/high/xhigh/max). 0 / unset = default.
        thinking_budget_tokens: z.number().int().min(0).max(64000).optional(),
    }).optional(),
});

export type GovernanceRequest = z.infer<typeof GovernanceRequestSchema>;

// Note: The legacy GovernanceEngine class (Regex-based PII + prompt injection)
// was removed in Phase 9 (technical debt cleanup). All governance is now handled by:
// - DLP Engine (src/lib/dlp-engine.ts) for PII detection
// - OPA Governance Engine (src/lib/opa-governance.ts) for policy evaluation

export class IntegrityService {
    public static signPayload(payload: any, secret: string): string {
        const logContent = JSON.stringify(payload);
        return crypto.createHmac('sha256', secret).update(logContent).digest('hex');
    }

    public static verifyPayload(payload: any, secret: string, signature: string): boolean {
        const expectedSignature = this.signPayload(payload, secret);
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    }
}
