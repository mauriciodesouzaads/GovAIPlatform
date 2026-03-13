import { describe, it, expect } from 'vitest';
import { DLPEngine, dlpEngine } from '../lib/dlp-engine';

describe('DLP Engine', () => {

    // -----------------------------------------------------------------------
    // CPF Detection
    // -----------------------------------------------------------------------
    describe('CPF Detection', () => {
        it('should detect and mask a valid formatted CPF', () => {
            const result = dlpEngine.sanitize('Meu CPF é 529.982.247-25 e gostaria de saber.');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[CPF_REDACTED]');
            expect(result.sanitizedText).not.toContain('529.982.247-25');
            expect(result.detections[0].type).toBe('CPF');
            expect(result.detections[0].confidence).toBe('HIGH');
        });

        it('should detect CPF without formatting', () => {
            const result = dlpEngine.sanitize('CPF: 52998224725');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[CPF_REDACTED]');
        });

        it('should NOT detect invalid CPF (bad checksum)', () => {
            const result = dlpEngine.sanitize('Número: 123.456.789-00');
            // 123.456.789-00 has invalid check digits
            expect(result.hasPII).toBe(false);
        });

        it('should NOT detect all-same-digit CPF', () => {
            const result = dlpEngine.sanitize('CPF: 111.111.111-11');
            expect(result.hasPII).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // CNPJ Detection
    // -----------------------------------------------------------------------
    describe('CNPJ Detection', () => {
        it('should detect and mask a valid CNPJ', () => {
            const result = dlpEngine.sanitize('A empresa com CNPJ 11.222.333/0001-81 solicitou.');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[CNPJ_REDACTED]');
            expect(result.detections[0].type).toBe('CNPJ');
        });

        it('should NOT detect an invalid CNPJ', () => {
            const result = dlpEngine.sanitize('CNPJ: 00.000.000/0000-00');
            expect(result.hasPII).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Credit Card Detection
    // -----------------------------------------------------------------------
    describe('Credit Card Detection', () => {
        it('should detect and mask a Visa card (Luhn valid)', () => {
            const result = dlpEngine.sanitize('Cartão: 4539 5782 3949 3478');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[CARD_REDACTED]');
            expect(result.detections[0].type).toBe('CREDIT_CARD');
        });

        it('should NOT detect a Luhn-invalid number', () => {
            const result = dlpEngine.sanitize('Número: 1234 5678 9012 3456');
            expect(result.hasPII).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Email Detection
    // -----------------------------------------------------------------------
    describe('Email Detection', () => {
        it('should detect and mask email addresses', () => {
            const result = dlpEngine.sanitize('Contato: joao.silva@empresa.com.br para mais info.');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[EMAIL_REDACTED]');
            expect(result.sanitizedText).not.toContain('joao.silva@empresa.com.br');
        });
    });

    // -----------------------------------------------------------------------
    // Phone Detection
    // -----------------------------------------------------------------------
    describe('Phone Detection', () => {
        it('should detect BR phone with area code', () => {
            const result = dlpEngine.sanitize('Ligue para (11) 98765-4321 agora.');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[PHONE_REDACTED]');
        });

        it('should detect phone with country code', () => {
            const result = dlpEngine.sanitize('WhatsApp: +55 11 98765-4321');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[PHONE_REDACTED]');
        });
    });

    // -----------------------------------------------------------------------
    // Bank Account Detection
    // -----------------------------------------------------------------------
    describe('Bank Account Detection', () => {
        it('should detect agência pattern', () => {
            const result = dlpEngine.sanitize('Agência: 1234 Conta: 56789-0');
            expect(result.hasPII).toBe(true);
            const types = result.detections.map(d => d.type);
            expect(types).toContain('BANK_ACCOUNT');
        });
    });

    // -----------------------------------------------------------------------
    // CEP Detection (context-aware)
    // -----------------------------------------------------------------------
    describe('CEP Detection', () => {
        it('should detect CEP when preceded by keyword', () => {
            const result = dlpEngine.sanitize('CEP: 01310-100');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[CEP_REDACTED]');
        });

        it('should NOT detect bare 8-digit number without context', () => {
            const result = dlpEngine.sanitize('O código é 01310100');
            // Without "CEP" keyword, should not detect
            expect(result.detections.filter(d => d.type === 'CEP')).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // Deep Object Sanitization
    // -----------------------------------------------------------------------
    describe('Deep Object Sanitization', () => {
        it('should sanitize all string values in nested objects', async () => {
            const obj = {
                input: 'Meu CPF é 529.982.247-25',
                output: {
                    message: {
                        content: 'Resposta com email admin@test.com'
                    }
                },
                usage: { tokens: 100 }
            };

            const { sanitized, totalDetections } = await dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBe(2);
            expect(sanitized.input).toContain('[CPF_REDACTED]');
            expect(sanitized.output.message.content).toContain('[EMAIL_REDACTED]');
            expect(sanitized.usage.tokens).toBe(100); // Non-string preserved
        });
    });

    // -----------------------------------------------------------------------
    // Multiple PII in same text
    // -----------------------------------------------------------------------
    describe('Multiple PII Detection', () => {
        it('should detect and mask multiple PII types in one text', () => {
            const text = 'CPF 529.982.247-25, email: joao@test.com, tel: (11) 98765-4321';
            const result = dlpEngine.sanitize(text);

            expect(result.hasPII).toBe(true);
            expect(result.detections.length).toBeGreaterThanOrEqual(3);
            expect(result.sanitizedText).toContain('[CPF_REDACTED]');
            expect(result.sanitizedText).toContain('[EMAIL_REDACTED]');
            expect(result.sanitizedText).toContain('[PHONE_REDACTED]');
            // Ensure no original data remains
            expect(result.sanitizedText).not.toContain('529.982.247-25');
            expect(result.sanitizedText).not.toContain('joao@test.com');
        });
    });

    // -----------------------------------------------------------------------
    // No PII
    // -----------------------------------------------------------------------
    describe('Clean Text (No PII)', () => {
        it('should return original text when no PII is found', () => {
            const text = 'Qual é a política de home office da empresa?';
            const result = dlpEngine.sanitize(text);
            expect(result.hasPII).toBe(false);
            expect(result.sanitizedText).toBe(text);
            expect(result.detections).toHaveLength(0);
        });
    });
});
