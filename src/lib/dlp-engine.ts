/**
 * DLP Engine — Data Loss Prevention for LGPD Compliance
 * 
 * Provides semantic detection and masking of PII (Personally Identifiable Information)
 * in text payloads BEFORE they are signed (HMAC-SHA256) and persisted to immutable audit logs.
 * 
 * Supported PII types:
 * - CPF (with checksum validation)
 * - CNPJ (with checksum validation)
 * - Credit/Debit Cards (Luhn algorithm)
 * - Email addresses
 * - Phone numbers (BR format — requires formatting markers)
 * - Bank account patterns
 * - CEP (postal codes)
 * - RG (identity document)
 * - PIX keys
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PIIDetection {
    type: string;
    original: string;
    masked: string;
    startIndex: number;
    endIndex: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface SanitizationResult {
    sanitizedText: string;
    detections: PIIDetection[];
    hasPII: boolean;
}

interface PIIDetector {
    type: string;
    detect(text: string): PIIDetection[];
}

// ---------------------------------------------------------------------------
// Validation Utilities
// ---------------------------------------------------------------------------

function isValidCPF(cpf: string): boolean {
    const digits = cpf.replace(/\D/g, '');
    if (digits.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(digits)) return false;

    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(digits[i]) * (10 - i);
    let r = (sum * 10) % 11;
    if (r === 10) r = 0;
    if (r !== parseInt(digits[9])) return false;

    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(digits[i]) * (11 - i);
    r = (sum * 10) % 11;
    if (r === 10) r = 0;
    if (r !== parseInt(digits[10])) return false;

    return true;
}

function isValidCNPJ(cnpj: string): boolean {
    const digits = cnpj.replace(/\D/g, '');
    if (digits.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(digits)) return false;

    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(digits[i]) * w1[i];
    let r = sum % 11;
    const d1 = r < 2 ? 0 : 11 - r;
    if (parseInt(digits[12]) !== d1) return false;

    sum = 0;
    for (let i = 0; i < 13; i++) sum += parseInt(digits[i]) * w2[i];
    r = sum % 11;
    const d2 = r < 2 ? 0 : 11 - r;
    if (parseInt(digits[13]) !== d2) return false;

    return true;
}

function isValidLuhn(number: string): boolean {
    const digits = number.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;

    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let n = parseInt(digits[i]);
        if (alt) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
        alt = !alt;
    }
    return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// PII Detectors
// ---------------------------------------------------------------------------

const cpfDetector: PIIDetector = {
    type: 'CPF',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];

        // 1) Formatted: XXX.XXX.XXX-XX
        const fmt = /\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/g;
        let m;
        while ((m = fmt.exec(text)) !== null) {
            if (isValidCPF(m[1])) {
                detections.push({
                    type: 'CPF', original: m[1], masked: '[CPF_REDACTED]',
                    startIndex: m.index, endIndex: m.index + m[1].length, confidence: 'HIGH'
                });
            }
        }

        // 2) Unformatted: exactly 11 consecutive digits
        const raw = /(?<!\d)(\d{11})(?!\d)/g;
        while ((m = raw.exec(text)) !== null) {
            if (isValidCPF(m[1])) {
                const overlap = detections.some(d =>
                    d.startIndex <= m!.index && d.endIndex >= m!.index + m![1].length
                );
                if (!overlap) {
                    detections.push({
                        type: 'CPF', original: m[1], masked: '[CPF_REDACTED]',
                        startIndex: m.index, endIndex: m.index + m[1].length, confidence: 'HIGH'
                    });
                }
            }
        }
        return detections;
    }
};

const cnpjDetector: PIIDetector = {
    type: 'CNPJ',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const p = /\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}[-.]?\d{2})\b/g;
        let m;
        while ((m = p.exec(text)) !== null) {
            const d = m[1].replace(/\D/g, '');
            if (d.length === 14 && isValidCNPJ(d)) {
                detections.push({
                    type: 'CNPJ', original: m[1], masked: '[CNPJ_REDACTED]',
                    startIndex: m.index, endIndex: m.index + m[1].length, confidence: 'HIGH'
                });
            }
        }
        return detections;
    }
};

const creditCardDetector: PIIDetector = {
    type: 'CREDIT_CARD',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const p = /\b(\d{4}[\s.-]\d{4}[\s.-]\d{4}[\s.-]\d{4})\b/g;
        let m;
        while ((m = p.exec(text)) !== null) {
            if (isValidLuhn(m[1])) {
                detections.push({
                    type: 'CREDIT_CARD', original: m[1], masked: '[CARD_REDACTED]',
                    startIndex: m.index, endIndex: m.index + m[1].length, confidence: 'HIGH'
                });
            }
        }
        return detections;
    }
};

const emailDetector: PIIDetector = {
    type: 'EMAIL',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const p = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;
        let m;
        while ((m = p.exec(text)) !== null) {
            detections.push({
                type: 'EMAIL', original: m[1], masked: '[EMAIL_REDACTED]',
                startIndex: m.index, endIndex: m.index + m[1].length, confidence: 'HIGH'
            });
        }
        return detections;
    }
};

/**
 * Phone detector — requires formatting markers (parentheses or +55 or dashes)
 * to avoid false positives on bare digit sequences like CPFs or card numbers.
 */
const phoneDetector: PIIDetector = {
    type: 'PHONE',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const patterns: RegExp[] = [
            /(\+55\s?\d{2}\s?\d{4,5}[-. ]\d{4})/g,    // +55 11 98765-4321
            /(\(\d{2}\)\s?\d{4,5}[-. ]\d{4})/g,        // (11) 98765-4321
        ];
        for (const p of patterns) {
            let m;
            while ((m = p.exec(text)) !== null) {
                detections.push({
                    type: 'PHONE', original: m[1].trim(), masked: '[PHONE_REDACTED]',
                    startIndex: m.index, endIndex: m.index + m[1].length, confidence: 'MEDIUM'
                });
            }
        }
        return detections;
    }
};

const bankAccountDetector: PIIDetector = {
    type: 'BANK_ACCOUNT',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const patterns = [
            /\b(ag[eê]ncia|ag\.?)\s*:?\s*(\d{4}[-.]?\d?)\b/gi,
            /\b(conta|cc|c\/c)\s*:?\s*(\d{4,12}[-.]?\d?)\b/gi,
        ];
        for (const p of patterns) {
            let m;
            while ((m = p.exec(text)) !== null) {
                detections.push({
                    type: 'BANK_ACCOUNT', original: m[0], masked: '[BANK_ACCOUNT_REDACTED]',
                    startIndex: m.index, endIndex: m.index + m[0].length, confidence: 'MEDIUM'
                });
            }
        }
        return detections;
    }
};

const cepDetector: PIIDetector = {
    type: 'CEP',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const p = /\b(cep|c[oó]digo\s*postal)\s*:?\s*(\d{5}[-.]?\d{3})\b/gi;
        let m;
        while ((m = p.exec(text)) !== null) {
            detections.push({
                type: 'CEP', original: m[0], masked: '[CEP_REDACTED]',
                startIndex: m.index, endIndex: m.index + m[0].length, confidence: 'MEDIUM'
            });
        }
        return detections;
    }
};

const rgDetector: PIIDetector = {
    type: 'RG',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const p = /\b(rg|identidade|registro\s*geral)\s*:?\s*(\d{1,2}\.?\d{3}\.?\d{3}[-.]?\d{1,2})\b/gi;
        let m;
        while ((m = p.exec(text)) !== null) {
            detections.push({
                type: 'RG', original: m[0], masked: '[RG_REDACTED]',
                startIndex: m.index, endIndex: m.index + m[0].length, confidence: 'MEDIUM'
            });
        }
        return detections;
    }
};

const pixKeyDetector: PIIDetector = {
    type: 'PIX_KEY',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const p = /\b(chave\s*pix|pix)\s*:?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\d{11,14}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
        let m;
        while ((m = p.exec(text)) !== null) {
            detections.push({
                type: 'PIX_KEY', original: m[0], masked: '[PIX_KEY_REDACTED]',
                startIndex: m.index, endIndex: m.index + m[0].length, confidence: 'MEDIUM'
            });
        }
        return detections;
    }
};

// ---------------------------------------------------------------------------
// DLP Engine
// ---------------------------------------------------------------------------

export class DLPEngine {
    private detectors: PIIDetector[];

    constructor() {
        this.detectors = [
            cpfDetector, cnpjDetector, creditCardDetector, emailDetector,
            phoneDetector, bankAccountDetector, cepDetector, rgDetector, pixKeyDetector,
        ];
    }

    /** Scan text and return deduplicated detections (higher confidence wins overlaps). */
    scan(text: string): PIIDetection[] {
        const all: PIIDetection[] = [];
        for (const det of this.detectors) all.push(...det.detect(text));

        const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
        const deduped = all.filter((d, i) =>
            !all.some((o, j) => {
                if (i === j) return false;
                const overlaps = d.startIndex < o.endIndex && d.endIndex > o.startIndex;
                if (!overlaps) return false;
                return rank[o.confidence] > rank[d.confidence] ||
                    (rank[o.confidence] === rank[d.confidence] && j < i);
            })
        );

        return deduped.sort((a, b) => b.startIndex - a.startIndex);
    }

    /** Sanitize text by replacing detected PII with masked tokens. */
    sanitize(text: string): SanitizationResult {
        const detections = this.scan(text);
        if (detections.length === 0) return { sanitizedText: text, detections: [], hasPII: false };

        let sanitized = text;
        for (const d of detections) {
            sanitized = sanitized.substring(0, d.startIndex) + d.masked + sanitized.substring(d.endIndex);
        }
        return { sanitizedText: sanitized, detections, hasPII: true };
    }

    /** Deep sanitize all string values in a nested object. */
    sanitizeObject(obj: any): { sanitized: any; totalDetections: number } {
        let total = 0;
        const recurse = (v: any): any => {
            if (typeof v === 'string') { const r = this.sanitize(v); total += r.detections.length; return r.sanitizedText; }
            if (Array.isArray(v)) return v.map(recurse);
            if (v !== null && typeof v === 'object') {
                const o: any = {};
                for (const k of Object.keys(v)) o[k] = recurse(v[k]);
                return o;
            }
            return v;
        };
        return { sanitized: recurse(obj), totalDetections: total };
    }
}

export const dlpEngine = new DLPEngine();
