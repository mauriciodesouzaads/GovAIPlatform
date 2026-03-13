import { describe, it, expect } from 'vitest';
import { dlpEngine } from '../lib/dlp-engine';

describe('DLP Engine — Extended Coverage', () => {

    // -----------------------------------------------------------------
    // RG Detection
    // -----------------------------------------------------------------
    describe('RG Detection', () => {
        it('should detect RG with keyword prefix', () => {
            const result = dlpEngine.sanitize('RG: 12.345.678-9');
            expect(result.hasPII).toBe(true);
            expect(result.sanitizedText).toContain('[RG_REDACTED]');
            expect(result.detections.some(d => d.type === 'RG')).toBe(true);
        });

        it('should detect RG with "identidade" keyword', () => {
            const result = dlpEngine.sanitize('Identidade: 12345678-9');
            expect(result.hasPII).toBe(true);
            expect(result.detections.some(d => d.type === 'RG')).toBe(true);
        });

        it('should NOT detect bare number without RG keyword', () => {
            const result = dlpEngine.sanitize('Número do pedido: 12345678-9');
            // Without RG/identidade keyword, the RG detector should NOT fire
            const rgDetections = result.detections.filter(d => d.type === 'RG');
            expect(rgDetections).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------
    // PIX Key Detection
    // -----------------------------------------------------------------
    describe('PIX Key Detection', () => {
        it('should detect PIX_KEY when email is used as PIX key (PIX context wins dedup)', () => {
            // PIX_KEY has HIGH confidence and runs first in the detector array.
            // When "Chave PIX: email@domain.com" is scanned, PIX_KEY matches the full
            // contextual span and wins over the narrower EMAIL detection in deduplication.
            const result = dlpEngine.sanitize('Chave PIX: joao@banco.com');
            expect(result.hasPII).toBe(true);
            expect(result.detections.some(d => d.type === 'PIX_KEY')).toBe(true);
            // EMAIL is deduplicated out because PIX_KEY spans the same range with equal confidence
            // and runs first in the detector array.
            expect(result.detections.some(d => d.type === 'EMAIL')).toBe(false);
        });

        it('should detect PIX key with UUID format', () => {
            const result = dlpEngine.sanitize('pix: 550e8400-e29b-41d4-a716-446655440000');
            expect(result.hasPII).toBe(true);
            expect(result.detections.some(d => d.type === 'PIX_KEY')).toBe(true);
        });

        it('should detect PIX_KEY when CPF digits are used as PIX key (PIX context wins dedup)', () => {
            // PIX_KEY has HIGH confidence and runs first — so it wins over CPF in dedup
            // when a valid CPF number appears after "Chave pix:" context.
            const result = dlpEngine.sanitize('Chave pix: 52998224725');
            expect(result.hasPII).toBe(true);
            expect(result.detections.some(d => d.type === 'PIX_KEY')).toBe(true);
            // CPF is deduplicated away because PIX_KEY spans the same range with equal
            // confidence and appears first in the detector priority order.
            expect(result.detections.some(d => d.type === 'CPF')).toBe(false);
        });
    });

    // -----------------------------------------------------------------
    // Phone Context-Aware Detection
    // -----------------------------------------------------------------
    describe('Phone (Context-Aware)', () => {
        it('should detect phone with "celular" keyword', () => {
            const result = dlpEngine.sanitize('celular: 11987654321');
            expect(result.hasPII).toBe(true);
            expect(result.detections.some(d => d.type === 'PHONE')).toBe(true);
            expect(result.sanitizedText).toContain('[PHONE_REDACTED]');
        });

        it('should detect phone with "whatsapp" keyword', () => {
            const result = dlpEngine.sanitize('WhatsApp 11987654321');
            expect(result.hasPII).toBe(true);
            expect(result.detections.some(d => d.type === 'PHONE')).toBe(true);
        });

        it('should NOT detect bare 11-digit number without context', () => {
            const result = dlpEngine.sanitize('ID do pedido: 11987654321');
            const phoneDetections = result.detections.filter(d => d.type === 'PHONE');
            expect(phoneDetections).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------
    // scan() Deduplication
    // -----------------------------------------------------------------
    describe('Scan Deduplication', () => {
        it('should not produce duplicate detections for overlapping patterns', () => {
            // A CPF is also 11 digits — only CPF (HIGH confidence) should survive
            const result = dlpEngine.sanitize('CPF 529.982.247-25');
            const cpfDetections = result.detections.filter(d => d.type === 'CPF');
            expect(cpfDetections).toHaveLength(1);
        });

        it('should produce exactly one detection when PIX_KEY and CPF overlap in PIX context', () => {
            // Both PIX_KEY and CPF are HIGH confidence. PIX_KEY runs first (priority order),
            // so the overlapping CPF detection is deduplicated out.
            // Result: exactly one detection (PIX_KEY), no duplicate for the same numeric value.
            const result = dlpEngine.sanitize('Chave pix: 52998224725');
            expect(result.detections).toHaveLength(1);
            expect(result.detections[0].type).toBe('PIX_KEY');
            expect(result.detections[0].confidence).toBe('HIGH');
        });

        it('should keep all detections when there is no overlap', () => {
            // CPF + email at different positions — both should survive
            const result = dlpEngine.sanitize('CPF: 529.982.247-25 email: admin@test.com');
            const types = result.detections.map(d => d.type);
            expect(types).toContain('CPF');
            expect(types).toContain('EMAIL');
            expect(result.detections.length).toBe(2);
        });
    });

    // -----------------------------------------------------------------
    // sanitizeObject — Edge Cases
    // -----------------------------------------------------------------
    describe('sanitizeObject Edge Cases', () => {
        it('should handle arrays inside objects', async () => {
            const obj = {
                items: [
                    'Email: joao@test.com',
                    'Texto limpo',
                    'CPF: 529.982.247-25'
                ]
            };
            const { sanitized, totalDetections } = await dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBeGreaterThanOrEqual(2);
            expect(sanitized.items[0]).toContain('[EMAIL_REDACTED]');
            expect(sanitized.items[1]).toBe('Texto limpo');
            expect(sanitized.items[2]).toContain('[CPF_REDACTED]');
        });

        it('should handle null values without error', async () => {
            const obj = { a: null, b: 'CPF: 529.982.247-25', c: undefined };
            const { sanitized, totalDetections } = await dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBeGreaterThanOrEqual(1);
            expect(sanitized.a).toBeNull();
            expect(sanitized.b).toContain('[CPF_REDACTED]');
        });

        it('should preserve numeric and boolean values', async () => {
            const obj = { count: 42, active: true, name: 'test' };
            const { sanitized, totalDetections } = await dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBe(0);
            expect(sanitized.count).toBe(42);
            expect(sanitized.active).toBe(true);
            expect(sanitized.name).toBe('test');
        });

        it('should handle deeply nested objects', async () => {
            const obj = {
                level1: {
                    level2: {
                        level3: {
                            secret: 'Email admin@deep.com escondido'
                        }
                    }
                }
            };
            const { sanitized, totalDetections } = await dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBe(1);
            expect(sanitized.level1.level2.level3.secret).toContain('[EMAIL_REDACTED]');
        });
    });
});
