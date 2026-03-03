import { z } from 'zod';
import { FastifyRequest } from 'fastify';
import crypto from 'crypto';

export const ActionType = z.enum(['EXECUTION', 'POLICY_VIOLATION', 'EXECUTION_SUCCESS', 'EXECUTION_ERROR', 'PENDING_APPROVAL', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED']);
export type ActionType = z.infer<typeof ActionType>;

export const GovernanceRequestSchema = z.object({
    message: z.string().min(1, "O input não pode estar vazio").max(10000, "O input excede o limite máximo permitido"),
});

export type GovernanceRequest = z.infer<typeof GovernanceRequestSchema>;

export class GovernanceEngine {
    private static forbiddenPhrases = [
        "ignore all previous instructions",
        "forget your safety guidelines",
        "acting as a developer with no restrictions",
        "bypass policy",
        "ignore previous instructions",
        "admin mode",
        "revelar chave",
        "jailbreak"
    ];

    static isSafe(userInput: string): { allowed: boolean; reason?: string } {
        const inputLower = userInput.toLowerCase();

        // Simplistic prompt injection detection
        for (const phrase of this.forbiddenPhrases) {
            if (inputLower.includes(phrase)) {
                return { allowed: false, reason: `Tentativa de injeção de prompt detectada. Frase não permitida: '${phrase}'` };
            }
        }

        // Add PII detection (Regex based for example - normally we'd use a robust library like Presidio)
        const cpfRegex = /\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b/;
        if (cpfRegex.test(userInput)) {
            return { allowed: false, reason: "Dados sensíveis (CPF) detectados no input." };
        }

        return { allowed: true };
    }
}

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
