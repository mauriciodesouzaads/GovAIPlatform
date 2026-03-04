/**
 * FRENTE 1: CRIPTOGRAFIA & BYOK (A CAIXA NEGRA)
 * Staff QA Engineer — Security Suite
 *
 * Testa a resistência da fundação AES-256-GCM a:
 * 1. Crypto-Shredding: destruição de chave torna os dados inacessíveis para sempre
 * 2. HMAC Integrity: adulteração de log é detectada e sinalizada com ASSINATURA INVÁLIDA
 */
import { describe, it, expect } from 'vitest';
import { CryptoService } from '../lib/crypto-service';
import { IntegrityService } from '../lib/governance';

// ─────────────────────────────────────────
// CENÁRIO 1: Crypto-Shredding / Key Revocation
// ─────────────────────────────────────────
describe('[BYOK] Crypto-Shredding — Key Revocation', () => {
    const ORIGINAL_KEY = '12345678901234567890123456789012'; // 32 chars — Org A master key
    const REVOKED_KEY = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // 32 chars — rotated/destroyed key

    it('should encrypt sensitive payload successfully with the original key', () => {
        const svc = new CryptoService(ORIGINAL_KEY);
        const plaintext = JSON.stringify({
            original_prompt: 'Qual o saldo da conta 12345-6?',
            llm_response: 'O saldo da conta corrente é R$ 85.420,00.'
        });

        const { content_encrypted_bytes, iv_bytes, auth_tag_bytes } = svc.encryptPayload(plaintext);

        expect(content_encrypted_bytes).toBeTruthy();
        expect(content_encrypted_bytes).not.toContain('saldo');       // plaintext MUST NOT appear
        expect(content_encrypted_bytes).not.toContain('85.420');
        expect(iv_bytes).toBeTruthy();
        expect(auth_tag_bytes).toBeTruthy();
    });

    it('🔥 CRYPTO-SHREDDING: after key revocation, decryption MUST fail — plaintext is unrecoverable', () => {
        // Step 1: Encrypt with the original (valid) key
        const svc = new CryptoService(ORIGINAL_KEY);
        const sensitivePlaintext = 'CPF: 123.456.789-09 — Valor transferido: R$ 1.000.000,00';
        const { content_encrypted_bytes, iv_bytes, auth_tag_bytes } = svc.encryptPayload(sensitivePlaintext);

        // Step 2: Simulate key revocation → instantiate with WRONG (destroyed) key
        const revokedSvc = new CryptoService(REVOKED_KEY);

        // Step 3: Attempt decryption using the revoked key — MUST throw
        expect(() => {
            revokedSvc.decryptPayload(content_encrypted_bytes, iv_bytes, auth_tag_bytes);
        }).toThrow();

        // Step 4: Verify the encrypted blob itself contains zero trace of the plaintext
        expect(content_encrypted_bytes).not.toContain('CPF');
        expect(content_encrypted_bytes).not.toContain('1.000.000');

        // Step 5: Even with the correct key but a tampered IV, decryption must fail
        const tamperedIV = Buffer.alloc(12, 0).toString('base64'); // zeroed IV
        expect(() => {
            svc.decryptPayload(content_encrypted_bytes, tamperedIV, auth_tag_bytes);
        }).toThrow();
    });

    it('should produce different ciphertexts every call (IV entropy prevents Rainbow Tables)', () => {
        const svc = new CryptoService(ORIGINAL_KEY);
        const payload = 'token secreto do cofre';

        const enc1 = svc.encryptPayload(payload);
        const enc2 = svc.encryptPayload(payload);
        const enc3 = svc.encryptPayload(payload);

        // Ciphertexts must differ (IV is random each call)
        expect(enc1.content_encrypted_bytes).not.toBe(enc2.content_encrypted_bytes);
        expect(enc2.content_encrypted_bytes).not.toBe(enc3.content_encrypted_bytes);

        // All must decrypt back to the same plaintext with the correct key
        expect(svc.decryptPayload(enc1.content_encrypted_bytes, enc1.iv_bytes, enc1.auth_tag_bytes)).toBe(payload);
        expect(svc.decryptPayload(enc2.content_encrypted_bytes, enc2.iv_bytes, enc2.auth_tag_bytes)).toBe(payload);
    });
});

// ─────────────────────────────────────────
// CENÁRIO 2: HMAC Integrity (Insider Threat Simulation)
// ─────────────────────────────────────────
describe('[BYOK] HMAC Integrity — Insider Tampering Attack', () => {
    const SECRET = 'super-secret-signing-key-32-chars!';

    it('should verify a clean audit log signature successfully', () => {
        const auditLog = {
            action: 'EXECUTION_SUCCESS',
            org_id: 'org-abc-123',
            metadata: { tokens: 250, cost: 0.0005, dlp: { masked: 0 } }
        };

        const signature = IntegrityService.signPayload(auditLog, SECRET);
        const isValid = IntegrityService.verifyPayload(auditLog, SECRET, signature);

        expect(isValid).toBe(true);
    });

    it('🔥 INSIDER ATTACK: tampering a single character in the audit log MUST signal ASSINATURA INVÁLIDA', () => {
        const originalLog = {
            action: 'EXECUTION_SUCCESS',
            org_id: 'org-abc-123',
            metadata: { tokens: 250, cost: 0.0005, amount_transferred: 1000 }
        };

        // Sign original log
        const signature = IntegrityService.signPayload(originalLog, SECRET);

        // Simulate internal DB tampering: attacker escalates amount
        const tamperedLog = {
            ...originalLog,
            metadata: { ...originalLog.metadata, amount_transferred: 9999999 }
        };

        const isValid = IntegrityService.verifyPayload(tamperedLog, SECRET, signature);

        // MUST fail — ASSINATURA INVÁLIDA
        expect(isValid).toBe(false);
    });

    it('🔥 INSIDER ATTACK: changing org_id in the record must also break the signature', () => {
        const originalLog = { action: 'APPROVAL_GRANTED', org_id: 'org-legit', metadata: {} };
        const signature = IntegrityService.signPayload(originalLog, SECRET);

        const crossTenantAttack = { ...originalLog, org_id: 'org-attacker' };
        expect(IntegrityService.verifyPayload(crossTenantAttack, SECRET, signature)).toBe(false);
    });

    it('should reject verification if a leaked signing secret is from a different environment', () => {
        const log = { action: 'EXECUTION_SUCCESS', org_id: 'org-x', metadata: { cost: 0 } };
        const productionSignature = IntegrityService.signPayload(log, SECRET);

        // Attacker tries to verify using a staging secret — must fail
        const stagingSecret = 'staging-secret-signing-key-32chr';
        expect(IntegrityService.verifyPayload(log, stagingSecret, productionSignature)).toBe(false);
    });
});
