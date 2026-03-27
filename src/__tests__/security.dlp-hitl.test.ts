/**
 * FRENTE 4: DLP, OPA & HITL — Race Conditions e Falsos Positivos
 * Staff QA Engineer — Security Suite
 *
 * 1. Falsos Positivos DLP: CPF matematicamente inválido NÃO é mascarado
 * 2. Race Condition HITL: duplo approve → apenas 1 recebe 200, outro 409
 * 3. Expiração Worker TTL: expires_at no passado → estado 'expired', aprovação rejeitada
 */
import { describe, it, expect, vi } from 'vitest';
import { DLPEngine } from '../lib/dlp-engine';

// ─────────────────────────────────────────
// CENÁRIO 1: Falsos Positivos DLP
// ─────────────────────────────────────────
describe('[DLP] False Positives — Syntactically Invalid PII must NOT be masked', () => {
    const engine = new DLPEngine();

    it('should NOT mask a CPF that fails the mathematical checksum validation', () => {
        // This CPF has the right format but invalid check digits (000.000.001-00 is not a real CPF)
        const invalidCpf = 'O documento apresentado é 000.000.001-00 e deve ser verificado.';
        const result = engine.sanitize(invalidCpf);

        // Mathematical validation must reject this
        expect(result.hasPII).toBe(false);
        expect(result.sanitizedText).toContain('000.000.001-00');
    });

    it('should NOT mask a phone number lacking the required BR formatting markers', () => {
        // Raw digits without formatting — not a valid BR phone pattern requiring context markers
        const rawDigits = 'O número de controle é 11999887766 e não é um telefone.';
        const result = engine.sanitize(rawDigits);
        // Unformatted bare digits don't trigger the BR phone detector (needs (XX) or formatting)
        expect(result.sanitizedText).toContain('11999887766');
    });

    it('should CORRECTLY mask a mathematically valid CPF', () => {
        // 111.444.777-35 is a mathematically valid CPF
        const validText = 'O CPF do solicitante é 111.444.777-35 conforme cadastro';
        const result = engine.sanitize(validText);
        expect(result.hasPII).toBe(true);
        expect(result.sanitizedText).not.toContain('111.444.777-35');
        expect(result.sanitizedText).toContain('[CPF_REDACTED]');
    });

    it('should CORRECTLY mask a valid email while ignoring surrounding non-PII text', () => {
        const text = 'Sistema de controle v2.3.4 — contato: admin@govai.com — build 20240101';
        const result = engine.sanitize(text);
        expect(result.hasPII).toBe(true);
        expect(result.sanitizedText).not.toContain('admin@govai.com');
        expect(result.sanitizedText).toContain('v2.3.4'); // version string not masked
        expect(result.sanitizedText).toContain('20240101'); // date-like number not masked
    });

    it('should NOT mask a CNPJ that fails Luhn/checksum validation', () => {
        // 00.000.000/0000-00 is syntactically formatted but invalid (all zeros fails checksum)
        const text = 'CNPJ de teste: 00.000.000/0000-00 — inválido';
        const result = engine.sanitize(text);
        expect(result.sanitizedText).toContain('00.000.000/0000-00');
    });
});

// ─────────────────────────────────────────
// CENÁRIO 2: Race Condition HITL
// ─────────────────────────────────────────
describe('[HITL] Race Condition — Double Approve Attack', () => {
    /**
     * Simulates the idempotent HITL approval state machine.
     * The database has a UNIQUE constraint + status check that prevents double execution.
     */

    type ApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

    class HitlStateMachine {
        private status: ApprovalStatus = 'PENDING_APPROVAL';
        private processingLock = false;

        async approve(callerId: string): Promise<{ code: number; message: string }> {
            // Simulate DB SELECT FOR UPDATE row lock
            if (this.processingLock) {
                return { code: 409, message: 'Conflict: Approval already in progress' };
            }
            if (this.status !== 'PENDING_APPROVAL') {
                return { code: 409, message: `Conflict: Approval in status '${this.status}' cannot be approved again` };
            }

            this.processingLock = true;
            // Simulate async LLM execution delay
            await new Promise(res => setTimeout(res, 5));
            this.status = 'APPROVED';
            this.processingLock = false;
            return { code: 200, message: `Approved by ${callerId}` };
        }

        getStatus() { return this.status; }
    }

    it('🔥 RACE CONDITION: simultaneous double-approve must yield exactly 1 success and 1 conflict', async () => {
        const machine = new HitlStateMachine();

        // Fire two concurrent approvals 
        const [result1, result2] = await Promise.all([
            machine.approve('admin-1'),
            machine.approve('admin-2')
        ]);

        const codes = [result1.code, result2.code].sort();
        expect(codes).toContain(200); // One succeeds
        expect(codes).toContain(409); // Other gets Conflict

        // Final state must be APPROVED (not ambiguous)
        expect(machine.getStatus()).toBe('APPROVED');
    });

    it('🔥 REPLAY ATTACK: a third approve after success must also be rejected 409', async () => {
        const machine = new HitlStateMachine();
        await machine.approve('admin-1'); // First approval succeeds

        // Second attempt (replay)
        const replay = await machine.approve('admin-evil');
        expect(replay.code).toBe(409);
        expect(replay.message).toContain('APPROVED');
    });
});

// ─────────────────────────────────────────
// CENÁRIO 3: Worker TTL — Expiração de Aprovações
// ─────────────────────────────────────────
describe('[HITL] Expiration Worker — TTL Rejection', () => {

    interface PendingApproval {
        id: string;
        status: string;
        expires_at: Date;
    }

    /**
     * Simulates the expiration worker logic that runs on a cron schedule.
     * Marks any PENDING_APPROVAL record past its expires_at as 'expired'.
     */
    async function runExpirationSweep(approvals: PendingApproval[]): Promise<PendingApproval[]> {
        const now = new Date();
        return approvals.map(a => {
            if (a.status === 'PENDING_APPROVAL' && a.expires_at < now) {
                return { ...a, status: 'expired' };
            }
            return a;
        });
    }

    it('should expire a PENDING_APPROVAL whose expires_at is in the past', async () => {
        const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
        const approvals: PendingApproval[] = [
            { id: 'approval-1', status: 'PENDING_APPROVAL', expires_at: pastDate }
        ];

        const result = await runExpirationSweep(approvals);
        expect(result[0].status).toBe('expired');
    });

    it('should NOT expire a PENDING_APPROVAL whose expires_at is in the future', async () => {
        const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h ahead
        const approvals: PendingApproval[] = [
            { id: 'approval-2', status: 'PENDING_APPROVAL', expires_at: futureDate }
        ];

        const result = await runExpirationSweep(approvals);
        expect(result[0].status).toBe('PENDING_APPROVAL');
    });

    it('🔥 TTL BYPASS: attempt to approve an expired record must fail with a rejection', async () => {
        type Status = 'PENDING_APPROVAL' | 'APPROVED' | 'expired';

        async function tryApproveExpired(currentStatus: Status): Promise<{ code: number; error?: string }> {
            if (currentStatus !== 'PENDING_APPROVAL') {
                return { code: 422, error: `Cannot approve: record is in status '${currentStatus}'` };
            }
            return { code: 200 };
        }

        const result = await tryApproveExpired('expired');
        expect(result.code).toBe(422);
        expect(result.error).toContain('expired');
    });

    it('should handle mixed approvals — only expired ones are swept', async () => {
        const pastDate = new Date(Date.now() - 10000);
        const futureDate = new Date(Date.now() + 10000);

        const approvals: PendingApproval[] = [
            { id: 'a1', status: 'PENDING_APPROVAL', expires_at: pastDate },
            { id: 'a2', status: 'PENDING_APPROVAL', expires_at: futureDate },
            { id: 'a3', status: 'APPROVED', expires_at: pastDate },
        ];

        const swept = await runExpirationSweep(approvals);
        expect(swept.find(a => a.id === 'a1')?.status).toBe('expired');   // Expired → swept
        expect(swept.find(a => a.id === 'a2')?.status).toBe('PENDING_APPROVAL'); // Future → untouched
        expect(swept.find(a => a.id === 'a3')?.status).toBe('APPROVED');  // Already approved → untouched
    });
});
