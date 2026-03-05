import { describe, it, expect } from 'vitest';
import { CryptoService } from '../lib/crypto-service';
import { LocalKmsAdapter } from '../lib/kms';

describe('CryptoService (Caixa Negra - AES-256-GCM)', () => {
    const validMasterKey = '12345678901234567890123456789012'; // 32 characters
    const cryptoService = new CryptoService(new LocalKmsAdapter(validMasterKey));

    it('should throw an error if the master key is not 32 bytes', () => {
        expect(() => new CryptoService(new LocalKmsAdapter('short-key'))).toThrowError("LocalKmsAdapter requer ORG_MASTER_KEY com pelo menos 32 caracteres (256-bit).");
    });

    it('should encrypt and decrypt a plaintext payload successfully', async () => {
        const orgMasterKey = 'd43a6bc1c6f4a8e2b9d0e1f3g4h5i6j7'; // exactly 32 chars
        const cryptoService = new CryptoService(new LocalKmsAdapter(orgMasterKey));

        const payload = JSON.stringify({
            original_prompt: "Quais são as regras para aposentadoria compulsória?",
            llm_response: "Segundo o Art. 40 da Constituição, a aposentadoria compulsória..."
        });

        // 1. Encrypt
        const encrypted = await cryptoService.encryptPayload(payload);

        expect(encrypted.content_encrypted_bytes).toBeDefined();
        expect(encrypted.iv_bytes).toBeDefined();
        expect(encrypted.auth_tag_bytes).toBeDefined();
        expect(encrypted.encrypted_dek).toBeDefined();

        // 2. Decrypt
        const decryptedPayload = await cryptoService.decryptPayload(
            encrypted.content_encrypted_bytes,
            encrypted.iv_bytes,
            encrypted.auth_tag_bytes,
            encrypted.encrypted_dek
        );

        expect(decryptedPayload).toBe(payload);
    });

    it('should generate unique IVs for the same plaintext (No Rainbow Tables)', async () => {
        const payload = 'top-secret';

        const first = await cryptoService.encryptPayload(payload);
        const second = await cryptoService.encryptPayload(payload);

        expect(first.iv_bytes).not.toBe(second.iv_bytes);
        expect(first.content_encrypted_bytes).not.toBe(second.content_encrypted_bytes);
    });

    it('should fail decryption if auth tag is tampered with (Integrity Check)', async () => {
        const cryptoService = new CryptoService(new LocalKmsAdapter('d43a6bc1c6f4a8e2b9d0e1f3g4h5i6j7'));
        const payload = "Dados sensíveis";

        const { content_encrypted_bytes, iv_bytes, auth_tag_bytes, encrypted_dek } = await cryptoService.encryptPayload(payload);

        // Tamper with the auth tag
        const tamperedAuthTag = Buffer.from(auth_tag_bytes, 'base64');
        tamperedAuthTag[0] = tamperedAuthTag[0] ^ 1; // flip a bit

        await expect(
            cryptoService.decryptPayload(content_encrypted_bytes, iv_bytes, tamperedAuthTag.toString('base64'), encrypted_dek)
        ).rejects.toThrow(/Unsupported state or unable to authenticate data|DecipherFirst fails/i);
    });
});
