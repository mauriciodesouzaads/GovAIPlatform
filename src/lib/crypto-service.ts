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

// ==========================================
// CRYPTO SERVICE (PASSO 2 - Stub)
// ==========================================

export class CryptoService {
    private readonly ALGORITHM = 'aes-256-gcm';

    /**
     * @param orgMasterKey A chave KMS ou BYOK da organização (deve ter 32 bytes para AES-256)
     */
    constructor(private defaultMasterKey: string) {
        if (defaultMasterKey.length !== 32) {
            throw new Error("Master Key deve conter exatos 32 caracteres (256 bits).");
        }
    }

    /**
     * Cifra um payload textual usando AES-256-GCM com IV randômico.
     */
    encryptPayload(payloadStr: string): { content_encrypted_bytes: string, iv_bytes: string, auth_tag_bytes: string } {
        const iv = crypto.randomBytes(12); // Padrão recomendado pela NIST para GCM
        const key = Buffer.from(this.defaultMasterKey, 'utf8');

        const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

        let encrypted = cipher.update(payloadStr, 'utf8', 'base64');
        encrypted += cipher.final('base64');

        const authTag = cipher.getAuthTag();

        return {
            content_encrypted_bytes: encrypted,
            iv_bytes: iv.toString('base64'),
            auth_tag_bytes: authTag.toString('base64')
        };
    }

    /**
     * Decifra um payload em Base64 usando AES-256-GCM validando a tag de autenticação.
     */
    decryptPayload(ciphertextBase64: string, ivBase64: string, authTagBase64: string): string {
        const iv = Buffer.from(ivBase64, 'base64');
        const authTag = Buffer.from(authTagBase64, 'base64');
        const key = Buffer.from(this.defaultMasterKey, 'utf8');

        const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertextBase64, 'base64', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }
}
