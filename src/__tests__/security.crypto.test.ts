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
import { LocalKmsAdapter } from '../lib/kms';
import { IntegrityService } from '../lib/governance';

// ─────────────────────────────────────────
// CENÁRIO 1: Crypto-Shredding / Key Revocation
// ─────────────────────────────────────────
describe('[BYOK] Crypto-Shredding — Key Revocation', () => {
    const ORIGINAL_KEY = '12345678901234567890123456789012'; // 32 chars — Org A master key
    const REVOKED_KEY = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // 32 chars — rotated/destroyed key

    it('should encrypt sensitive payload successfully with the original key', async () => {
        const svc = new CryptoService(new LocalKmsAdapter(ORIGINAL_KEY));
        const plaintext = JSON.stringify({
            original_prompt: 'Qual o saldo da conta 12345-6?',
            llm_response: 'O saldo da conta corrente é R$ 85.420,00.'
        });

        const { content_encrypted_bytes, iv_bytes, auth_tag_bytes, encrypted_dek } = await svc.encryptPayload(plaintext);

        expect(content_encrypted_bytes).toBeTruthy();
        expect(content_encrypted_bytes).not.toContain('saldo');       // plaintext MUST NOT appear
        expect(content_encrypted_bytes).not.toContain('85.420');
        expect(iv_bytes).toBeTruthy();
        expect(auth_tag_bytes).toBeTruthy();
        expect(encrypted_dek).toBeTruthy();
    });

    it('🔥 CRYPTO-SHREDDING: after key revocation, decryption MUST fail — plaintext is unrecoverable', async () => {
        const orgMasterKey = 'd43a6bc1c6f4a8e2b9d0e1f3g4h5i6j7'; // 32 bytes
        const cryptoSvc = new CryptoService(new LocalKmsAdapter(orgMasterKey));

        const payload = "Cidadão Joao da Silva CPF 123.456.789-00 processa o Estado por...";
        const { content_encrypted_bytes, iv_bytes, auth_tag_bytes, encrypted_dek } = await cryptoSvc.encryptPayload(payload);

        // Simulando a revogação da chave (Crypto-Shredding)
        // Se a chave for perdida ou alterada intencionalmente, a descriptografia deve falhar 100%
        const revokedKey = 'd43a6bc1c6f4a8e2b9d0e1f3g4h5i6j8'; // Changed last char
        const revokedSvc = new CryptoService(new LocalKmsAdapter(revokedKey));

        await expect(
            revokedSvc.decryptPayload(content_encrypted_bytes, iv_bytes, auth_tag_bytes, encrypted_dek)
        ).rejects.toThrow();

        // Step 4: Verify the encrypted blob itself contains zero trace of the plaintext
        expect(content_encrypted_bytes).not.toContain('CPF');
        const svc = new CryptoService(new LocalKmsAdapter('d43a6bc1c6f4a8e2b9d0e1f3g4h5i6j7'));
        const { content_encrypted_bytes: content_encrypted_bytes_2, iv_bytes: iv_bytes_2, auth_tag_bytes: auth_tag_bytes_2, encrypted_dek: encrypted_dek_2 } = await svc.encryptPayload("Secret");

        // Flip one bit in IV
        const tamperedIV = Buffer.from(iv_bytes_2, 'base64');
        tamperedIV[0] = tamperedIV[0] ^ 1;

        await expect(
            svc.decryptPayload(content_encrypted_bytes_2, tamperedIV.toString('base64'), auth_tag_bytes_2, encrypted_dek_2)
        ).rejects.toThrow();
    });

    it('should produce different ciphertexts every call (IV entropy prevents Rainbow Tables)', async () => {
        const svc = new CryptoService(new LocalKmsAdapter('d43a6bc1c6f4a8e2b9d0e1f3g4h5i6j7'));
        const payload = "Secret Payload";

        const enc1 = await svc.encryptPayload(payload);
        const enc2 = await svc.encryptPayload(payload);

        // Avaliando as saídas GCM
        expect(enc1.iv_bytes).not.toEqual(enc2.iv_bytes); // IVs devem ser diferentes
        expect(enc1.content_encrypted_bytes).not.toEqual(enc2.content_encrypted_bytes); // Ciphertexts devem ser completamente diferentes

        // Validar que ambos ainda podem ser abertos corretamente com os metadados certos
        expect(await svc.decryptPayload(enc1.content_encrypted_bytes, enc1.iv_bytes, enc1.auth_tag_bytes, enc1.encrypted_dek)).toBe(payload);
        expect(await svc.decryptPayload(enc2.content_encrypted_bytes, enc2.iv_bytes, enc2.auth_tag_bytes, enc2.encrypted_dek)).toBe(payload);
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
