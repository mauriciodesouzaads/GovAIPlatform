import crypto from 'crypto';
import { z } from 'zod';

// ==========================================
// TYPES & SCHEMAS (PASSO 1)
// ==========================================

export const EncryptedRunSchema = z.object({
    id: z.string().uuid().optional(),
    run_id: z.string().uuid(),
    org_id: z.string().uuid(),
    iv_bytes: z.string(),
    auth_tag_bytes: z.string(),
    content_encrypted_bytes: z.string(),
    encrypted_dek: z.string(),
    key_version: z.string(),
    created_at: z.date().optional()
});

export type EncryptedRun = z.infer<typeof EncryptedRunSchema>;

// Tipo para estruturar o Payload maciço que queremos proteger (Prompt e Resposta)
export const RunPayloadSchema = z.object({
    original_prompt: z.string(),
    llm_response: z.string().optional(),
    tools_called: z.any().optional()
});

export type RunPayload = z.infer<typeof RunPayloadSchema>;

import { KmsAdapter } from './kms';

// ==========================================
// CRYPTO SERVICE (PASSO 2 - Envelope Encryption)
// ==========================================

export class CryptoService {
    private readonly ALGORITHM = 'aes-256-gcm';

    /**
     * @param kmsAdapter The standard or AWS KMS adapter to encrypt/decrypt DEKs
     */
    constructor(private kmsAdapter: KmsAdapter) { }

    /**
     * Cifra um payload usando Envelope Encryption (DEK gerada localmente + Master Key no KMS)
     */
    async encryptPayload(payloadStr: string): Promise<{ content_encrypted_bytes: string, iv_bytes: string, auth_tag_bytes: string, encrypted_dek: string }> {
        // 1. Generate a massive 32-byte Data Encryption Key (DEK)
        const dek = crypto.randomBytes(32);

        // 2. Encrypt the DEK using the secure KMS (External OR Local Fallback)
        const encrypted_dek = await this.kmsAdapter.encrypt(dek.toString('base64'));

        // 3. Encrypt the massive payload locally using AES-256-GCM and the DEK
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(this.ALGORITHM, dek, iv);

        let encrypted = cipher.update(payloadStr, 'utf8', 'base64');
        encrypted += cipher.final('base64');

        const authTag = cipher.getAuthTag();

        return {
            content_encrypted_bytes: encrypted,
            iv_bytes: iv.toString('base64'),
            auth_tag_bytes: authTag.toString('base64'),
            encrypted_dek
        };
    }

    /**
     * Decifra um payload em Base64 resolvendo a Envelope Encryption.
     */
    async decryptPayload(ciphertextBase64: string, ivBase64: string, authTagBase64: string, encryptedDekBase64: string): Promise<string> {
        // 1. Decrypt the DEK from the KMS Provider
        const dekBase64 = await this.kmsAdapter.decrypt(encryptedDekBase64);
        const dek = Buffer.from(dekBase64, 'base64');

        // 2. Decrypt the payload
        const iv = Buffer.from(ivBase64, 'base64');
        const authTag = Buffer.from(authTagBase64, 'base64');

        const decipher = crypto.createDecipheriv(this.ALGORITHM, dek, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertextBase64, 'base64', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }
}
