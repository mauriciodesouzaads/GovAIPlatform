import { describe, it, expect, vi } from 'vitest';
import { dlpEngine } from '../lib/dlp-engine';

describe('DLP Security Leak Verification', () => {

    it('PROOOF: Tier 2 sanitizeObject must be async and use semantic filtering', async () => {
        const obj = {
            message: "O usuário João Silva solicitou acesso",
            context: "Configuração de rede"
        };

        // Mock Presidio to ensure it's being called
        const spy = vi.spyOn(dlpEngine, 'sanitizeSemanticNLP');

        const { sanitized } = await dlpEngine.sanitizeObject(obj);

        expect(spy).toHaveBeenCalled();
        // Since we don't have a real Presidio running in CI, we expect the fallback or real result
        // The main point is that it IS async and DOES call the semantic engine.
        expect(typeof sanitized.message).toBe('string');
        spy.mockRestore();
    });

    it('PROOF: Improved PIX Detection prevents false positives on generic numbers', async () => {
        const textWithPix = "Pagar via pix: 529.982.247-25";
        const textWithoutPix = "O número do protocolo é 529.982.247-25";

        const resultWith = dlpEngine.sanitize(textWithPix);
        const resultWithout = dlpEngine.sanitize(textWithoutPix);

        expect(resultWith.detections.some(d => d.type === 'PIX_KEY')).toBe(true);
        // Should NOT detect as PIX_KEY if no context
        const pixInProtocol = resultWithout.detections.filter(d => d.type === 'PIX_KEY');
        expect(pixInProtocol).toHaveLength(0);

        const cpfInProtocol = resultWithout.detections.filter(d => d.type === 'CPF');
        expect(cpfInProtocol.length).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------
    // DLP → RAG pipeline: safeMessage must not carry raw PII into search
    // These tests verify the contract that execution.service.ts relies on:
    //   const safeMessage = policyCheck.sanitizedInput || message;
    //   searchWithTokenLimit(pool, kbId, safeMessage, model, limit)
    // -----------------------------------------------------------------

    it('CPF in input → safeMessage does not contain raw CPF', () => {
        const rawMsg = 'Meu CPF é 529.982.247-25, quero consultar meus benefícios';
        const result = dlpEngine.sanitize(rawMsg);
        // safeMessage = policyCheck.sanitizedInput (result.sanitizedText) || rawMsg
        const safeMessage = result.hasPII ? result.sanitizedText : rawMsg;
        expect(safeMessage).not.toContain('529.982.247-25');
        expect(safeMessage).toContain('[CPF_REDACTED]');
        expect(result.hasPII).toBe(true);
    });

    it('CNPJ + email in input → both masked in safeMessage', () => {
        const rawMsg = 'A empresa 11.444.777/0001-61 entrou em contato por contato@empresa.com.br';
        const result = dlpEngine.sanitize(rawMsg);
        const safeMessage = result.hasPII ? result.sanitizedText : rawMsg;
        expect(safeMessage).not.toContain('11.444.777/0001-61');
        expect(safeMessage).not.toContain('contato@empresa.com.br');
        expect(safeMessage).toContain('[CNPJ_REDACTED]');
        expect(safeMessage).toContain('[EMAIL_REDACTED]');
        expect(result.detections.map(d => d.type)).toContain('CNPJ');
        expect(result.detections.map(d => d.type)).toContain('EMAIL');
    });

    it('clean message → safeMessage identical to input (no false positives)', () => {
        const clean = 'Qual é a política de home office da empresa?';
        const result = dlpEngine.sanitize(clean);
        const safeMessage = result.hasPII ? result.sanitizedText : clean;
        expect(safeMessage).toBe(clean);
        expect(result.hasPII).toBe(false);
        expect(result.detections).toHaveLength(0);
    });

    it('DLP FLAG → opaEngine.evaluate returns sanitizedInput for safeMessage', async () => {
        const { OpaGovernanceEngine } = await import('../lib/opa-governance');
        const engine = new OpaGovernanceEngine();
        const rawMsg = 'Meu CPF é 529.982.247-25, quero ajuda com o cadastro';
        const decision = await engine.evaluate(
            { message: rawMsg },
            { rules: { pii_filter: true } }
        );
        // Governance engine must return FLAG with sanitizedInput set
        expect(decision.action).toBe('FLAG');
        expect(decision.sanitizedInput).toBeDefined();
        // safeMessage = policyCheck.sanitizedInput || rawMsg — must not carry raw CPF
        const safeMessage = decision.sanitizedInput ?? rawMsg;
        expect(safeMessage).not.toContain('529.982.247-25');
        expect(safeMessage).toContain('[CPF_REDACTED]');
    });

    // -----------------------------------------------------------------
    // DT-P05-RAG2: Approval flow — PII must not leak into RAG search
    // Verifies the fix in approvals.routes.ts:
    //   const safeApprovalMessage = dlpEngine.sanitize(approval.message).sanitizedText;
    //   searchWithTokenLimit(pgPool, kbId, safeApprovalMessage, aiModel, 10)
    // -----------------------------------------------------------------

    it('CPF in approval message → safeApprovalMessage does not reach RAG with raw PII', () => {
        // Simulates what approvals.routes.ts does before calling searchWithTokenLimit
        const approvalMessage = 'Por favor processe o pedido do CPF 529.982.247-25';
        const safeApprovalMessage = dlpEngine.sanitize(approvalMessage).sanitizedText;

        // The argument passed to searchWithTokenLimit must not contain the raw CPF
        expect(safeApprovalMessage).not.toContain('529.982.247-25');
        expect(safeApprovalMessage).toContain('[CPF_REDACTED]');
    });

    it('approval message already sanitized → double-sanitize is idempotent (no data loss)', () => {
        // When approval.message is already sanitized (as stored in pending_approvals),
        // applying dlpEngine.sanitize again must return identical text.
        const alreadySanitized = 'Solicitação do usuário com [CPF_REDACTED] processada com sucesso';
        const result = dlpEngine.sanitize(alreadySanitized);
        // No new detections — masked tokens are not re-detected
        expect(result.sanitizedText).toBe(alreadySanitized);
        expect(result.hasPII).toBe(false);
    });
});
