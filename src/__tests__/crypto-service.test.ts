import { describe, it, expect } from 'vitest';
import { CryptoService } from '../lib/crypto-service';

describe('CryptoService (Caixa Negra - AES-256-GCM)', () => {
    const validMasterKey = '12345678901234567890123456789012'; // 32 characters
    const cryptoService = new CryptoService(validMasterKey);

    it('should throw an error if the master key is not 32 bytes', () => {
        expect(() => new CryptoService('short-key')).toThrowError("Master Key deve conter exatos 32 caracteres (256 bits).");
    });

    it('should encrypt and decrypt a plaintext payload successfully', () => {
        const payload = JSON.stringify({ prompt: 'Me diga a capital do Brasil', response: 'Brasília' });

        const encryptedResult = cryptoService.encryptPayload(payload);

        expect(encryptedResult).toHaveProperty('content_encrypted_bytes');
        expect(encryptedResult).toHaveProperty('iv_bytes');
        expect(encryptedResult).toHaveProperty('auth_tag_bytes');

        // Decrypt mapping
        const decryptedPayload = cryptoService.decryptPayload(
            encryptedResult.content_encrypted_bytes,
            encryptedResult.iv_bytes,
            encryptedResult.auth_tag_bytes
        );

        expect(decryptedPayload).toBe(payload);
    });

    it('should generate unique IVs for the same plaintext (No Rainbow Tables)', () => {
        const payload = 'top-secret';

        const first = cryptoService.encryptPayload(payload);
        const second = cryptoService.encryptPayload(payload);

        expect(first.iv_bytes).not.toBe(second.iv_bytes);
        expect(first.content_encrypted_bytes).not.toBe(second.content_encrypted_bytes);
    });

    it('should fail decryption if auth tag is tampered with (Integrity Check)', () => {
        const payload = 'top-secret';
        const { content_encrypted_bytes, iv_bytes, auth_tag_bytes } = cryptoService.encryptPayload(payload);

        // Tamper auth tag by changing a character
        const tamperedAuthTag = Buffer.from(auth_tag_bytes, 'base64').map(b => b ^ 1).toString('base64');

        expect(() => {
            cryptoService.decryptPayload(content_encrypted_bytes, iv_bytes, tamperedAuthTag);
        }).toThrow();
    });
});
