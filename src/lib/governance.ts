import { z } from 'zod';
import { FastifyRequest } from 'fastify';
import crypto from 'crypto';

export const ActionType = z.enum(['EXECUTION', 'POLICY_VIOLATION', 'EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'PENDING_APPROVAL', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED']);
export type ActionType = z.infer<typeof ActionType>;

export const GovernanceRequestSchema = z.object({
    message: z.string().min(1, "O input não pode estar vazio").max(10000, "O input excede o limite máximo permitido"),
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
