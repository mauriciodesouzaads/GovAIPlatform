import crypto from 'crypto';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

/**
 * Generic Interface for Key Management System Adapters.
 * Provides abstract encrypt and decrypt methods for true BYOK.
 */
export interface KmsAdapter {
    /**
     * Encrypts plaintext using the configured KMS provider.
     * @param plaintext The text to encrypt.
     * @returns A base64-encoded string representing the ciphertext.
     */
    encrypt(plaintext: string): Promise<string>;

    /**
     * Decrypts ciphertext using the configured KMS provider.
     * @param ciphertextBase64 The base64-encoded ciphertext.
     * @returns The decrypted plaintext string.
     */
    decrypt(ciphertextBase64: string): Promise<string>;
}

/**
 * Local KMS Adapter (Fallback)
 * Uses the ORG_MASTER_KEY for local AES-256-GCM encryption without external dependencies.
 */
export class LocalKmsAdapter implements KmsAdapter {
    private readonly ALGORITHM = 'aes-256-gcm';
    private key: Buffer;

    constructor(masterKeyHex: string) {
        if (!masterKeyHex || masterKeyHex.length < 32) {
            throw new Error("LocalKmsAdapter requer ORG_MASTER_KEY com pelo menos 32 caracteres (256-bit).");
        }
        // Se a chave for 64 hex chars (gerada com `openssl rand -hex 32`),
        // parseia como hex para obter 32 bytes com 256 bits de entropia real.
        // Caso contrário, usa UTF-8 (compatibilidade com chaves de texto).
        if (/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
            this.key = Buffer.from(masterKeyHex, 'hex');
        } else {
            this.key = Buffer.from(masterKeyHex.substring(0, 32), 'utf8');
        }
    }

    async encrypt(plaintext: string): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                const iv = crypto.randomBytes(12);
                const cipher = crypto.createCipheriv(this.ALGORITHM, this.key, iv);

                let encrypted = cipher.update(plaintext, 'utf8', 'base64');
                encrypted += cipher.final('base64');

                const authTag = cipher.getAuthTag();

                // Format: IV:AuthTag:Ciphertext (all base64)
                const payload = `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
                resolve(Buffer.from(payload).toString('base64'));
            } catch (err) {
                reject(err);
            }
        });
    }

    async decrypt(ciphertextBase64: string): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                const payloadStr = Buffer.from(ciphertextBase64, 'base64').toString('utf8');
                const parts = payloadStr.split(':');
                if (parts.length !== 3) {
                    throw new Error("Formato de ciphertext local inválido. Esperado IV:AuthTag:Ciphertext");
                }

                const iv = Buffer.from(parts[0], 'base64');
                const authTag = Buffer.from(parts[1], 'base64');
                const encrypted = parts[2];

                const decipher = crypto.createDecipheriv(this.ALGORITHM, this.key, iv);
                decipher.setAuthTag(authTag);

                let decrypted = decipher.update(encrypted, 'base64', 'utf8');
                decrypted += decipher.final('utf8');

                resolve(decrypted);
            } catch (err) {
                reject(err);
            }
        });
    }
}

/**
 * AWS KMS Adapter (True BYOK)
 * Leverages AWS KMS for enterprise-grade hardware security module encryption.
 */
export class AwsKmsAdapter implements KmsAdapter {
    private kmsClient: KMSClient;

    constructor(
        region: string,
        private keyId: string
    ) {
        this.kmsClient = new KMSClient({ region });
    }

    async encrypt(plaintext: string): Promise<string> {
        const command = new EncryptCommand({
            KeyId: this.keyId,
            Plaintext: Buffer.from(plaintext, 'utf8'),
        });

        const response = await this.kmsClient.send(command);

        if (!response.CiphertextBlob) {
            throw new Error("AWS KMS não retornou CiphertextBlob.");
        }
        return Buffer.from(response.CiphertextBlob).toString('base64');
    }

    async decrypt(ciphertextBase64: string): Promise<string> {
        const command = new DecryptCommand({
            KeyId: this.keyId,
            CiphertextBlob: Buffer.from(ciphertextBase64, 'base64'),
        });

        const response = await this.kmsClient.send(command);

        if (!response.Plaintext) {
            throw new Error("AWS KMS não retornou Plaintext.");
        }
        return Buffer.from(response.Plaintext).toString('utf8');
    }
}

/**
 * Factory to get the appropriate KMS Adapter based on environment variables.
 */
export function getKmsAdapter(): KmsAdapter {
    const provider = process.env.KMS_PROVIDER || 'local';

    if (provider === 'aws') {
        const region = process.env.AWS_REGION;
        const keyId = process.env.AWS_KMS_KEY_ID;

        if (!region || !keyId) {
            throw new Error("AWS_REGION e AWS_KMS_KEY_ID são obrigatórios quando KMS_PROVIDER=aws");
        }
        return new AwsKmsAdapter(region, keyId);
    }

    // Adaptador local: ORG_MASTER_KEY é obrigatória em produção.
    // Em produção, exige explicitamente uma chave hex de 64 chars (gerada com
    // `openssl rand -hex 32`). Qualquer outro formato indica configuração
    // incorreta ou uso acidental de uma chave de desenvolvimento.
    const masterKey = process.env.ORG_MASTER_KEY;
    const isProductionEnv = process.env.NODE_ENV === 'production';

    if (isProductionEnv) {
        if (!masterKey || !/^[0-9a-fA-F]{64}$/.test(masterKey)) {
            throw new Error(
                '[SECURITY] ORG_MASTER_KEY inválida ou ausente em PRODUÇÃO. ' +
                'Gere uma chave segura com: openssl rand -hex 32'
            );
        }
        return new LocalKmsAdapter(masterKey);
    }

    if (!masterKey) {
        // Ambiente de desenvolvimento/teste: avisa e usa chave fixa de dev.
        // NUNCA use esta chave fora do ambiente local.
        console.warn(
            '[KMS] AVISO: ORG_MASTER_KEY não definida. ' +
            'Usando chave temporária de desenvolvimento. ' +
            'NUNCA use em staging ou produção.'
        );
        return new LocalKmsAdapter('govai-dev-only-kms-key-not-for-prod!!');
    }
    return new LocalKmsAdapter(masterKey);
}
