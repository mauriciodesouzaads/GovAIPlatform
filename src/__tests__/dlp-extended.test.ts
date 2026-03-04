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
        it('should detect PII in PIX key with email format (EMAIL detector wins dedup)', () => {
            const result = dlpEngine.sanitize('Chave PIX: joao@banco.com');
            expect(result.hasPII).toBe(true);
            // The EMAIL detector (HIGH confidence) wins over PIX_KEY (MEDIUM) in dedup
            expect(result.detections.some(d => d.type === 'EMAIL')).toBe(true);
        });

        it('should detect PIX key with UUID format', () => {
            const result = dlpEngine.sanitize('pix: 550e8400-e29b-41d4-a716-446655440000');
            expect(result.hasPII).toBe(true);
            expect(result.detections.some(d => d.type === 'PIX_KEY')).toBe(true);
        });

        it('should detect PII in PIX key with CPF digits (CPF detector wins dedup)', () => {
            const result = dlpEngine.sanitize('Chave pix: 52998224725');
            expect(result.hasPII).toBe(true);
            // The CPF detector (HIGH confidence) wins over PIX_KEY (MEDIUM) in dedup
            expect(result.detections.some(d => d.type === 'CPF')).toBe(true);
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

        it('should keep HIGH confidence detection and discard MEDIUM for same range', () => {
            // "Chave pix: 52998224725" — CPF (HIGH) overlaps with PIX_KEY (MEDIUM)
            const result = dlpEngine.sanitize('Chave pix: 52998224725');
            const highConf = result.detections.filter(d => d.confidence === 'HIGH');
            const medConf = result.detections.filter(d => d.confidence === 'MEDIUM');
            // The HIGH confidence detection (CPF) should survive
            expect(highConf.length).toBeGreaterThanOrEqual(1);
            // MEDIUM detections for the same overlapping range should be removed
            const pixForSameRange = medConf.filter(d =>
                d.type === 'PIX_KEY' && highConf.some(h =>
                    d.startIndex < h.endIndex && d.endIndex > h.startIndex
                )
            );
            expect(pixForSameRange).toHaveLength(0);
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
        it('should handle arrays inside objects', () => {
            const obj = {
                items: [
                    'Email: joao@test.com',
                    'Texto limpo',
                    'CPF: 529.982.247-25'
                ]
            };
            const { sanitized, totalDetections } = dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBeGreaterThanOrEqual(2);
            expect(sanitized.items[0]).toContain('[EMAIL_REDACTED]');
            expect(sanitized.items[1]).toBe('Texto limpo');
            expect(sanitized.items[2]).toContain('[CPF_REDACTED]');
        });

        it('should handle null values without error', () => {
            const obj = { a: null, b: 'CPF: 529.982.247-25', c: undefined };
            const { sanitized, totalDetections } = dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBeGreaterThanOrEqual(1);
            expect(sanitized.a).toBeNull();
            expect(sanitized.b).toContain('[CPF_REDACTED]');
        });

        it('should preserve numeric and boolean values', () => {
            const obj = { count: 42, active: true, name: 'test' };
            const { sanitized, totalDetections } = dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBe(0);
            expect(sanitized.count).toBe(42);
            expect(sanitized.active).toBe(true);
            expect(sanitized.name).toBe('test');
        });

        it('should handle deeply nested objects', () => {
            const obj = {
                level1: {
                    level2: {
                        level3: {
                            secret: 'Email admin@deep.com escondido'
                        }
                    }
                }
            };
            const { sanitized, totalDetections } = dlpEngine.sanitizeObject(obj);
            expect(totalDetections).toBe(1);
            expect(sanitized.level1.level2.level3.secret).toContain('[EMAIL_REDACTED]');
        });
    });
});
