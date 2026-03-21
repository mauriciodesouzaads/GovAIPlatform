/**
 * GovAI Platform — Centralised Zod input schemas
 *
 * All API endpoints that accept a request body MUST validate against one of
 * these schemas using `.safeParse(request.body)` before processing any data.
 * This enforces consistent 400 responses, prevents oversized payloads from
 * reaching business logic, and eliminates prototype-pollution vectors.
 */
import { z } from 'zod';

// ── Auth ──────────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(128),
});

const StrongPasswordSchema = z.string().min(12).max(128)
    .regex(/[A-Z]/, 'Deve conter ao menos 1 maiúscula')
    .regex(/[0-9]/, 'Deve conter ao menos 1 número')
    .regex(/[^A-Za-z0-9]/, 'Deve conter ao menos 1 caractere especial');

export const ChangePasswordSchema = z.object({
    currentPassword: z.string().min(8).max(128),
    newPassword: StrongPasswordSchema,
});

export const FirstLoginResetSchema = z.object({
    resetToken: z.string().min(10),
    newPassword: StrongPasswordSchema,
});

// ── Assistants ────────────────────────────────────────────────────────────────

export const AssistantSchema = z.object({
    name: z.string().min(1).max(100),
    systemPrompt: z.string().min(1).max(10000).optional().default(
        'Você é um assistente corporativo. Responda de forma objetiva e profissional.'
    ),
    model: z.string().max(100).optional(),
    knowledgeBaseId: z.string().uuid().optional(),
});

/** @deprecated Use AssistantSchema */
export const CreateAssistantSchema = AssistantSchema;

// ── API Keys ──────────────────────────────────────────────────────────────────

export const CreateApiKeySchema = z.object({
    name: z.string().min(1).max(100),
    expiresAt: z.string().datetime().optional(),
});

// ── Approvals ─────────────────────────────────────────────────────────────────

export const ApprovalActionSchema = z.object({
    reviewNote: z.string().min(1).max(2000),
});

// ── Organizations ─────────────────────────────────────────────────────────────

export const TelemetryConsentSchema = z.object({
    consent: z.boolean(),
    pii_strip: z.boolean().optional(),
});

// ── Users ─────────────────────────────────────────────────────────────────────

export const UpdateUserRoleSchema = z.object({
    role: z.enum(['admin', 'platform_admin', 'operator', 'sre', 'dpo', 'auditor']),
});

// ── Shared helper ─────────────────────────────────────────────────────────────

/**
 * Formats Zod issues into a flat, API-friendly array.
 * Usage: zodErrors(result.error)
 */
export function zodErrors(error: z.ZodError): Array<{ field: string; message: string }> {
    return error.issues.map(i => ({
        field: i.path.join('.') || 'body',
        message: i.message,
    }));
}
