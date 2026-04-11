/**
 * DLP Engine — Data Loss Prevention for LGPD Compliance
 *
 * Provides semantic detection and masking of PII (Personally Identifiable Information)
 * in text payloads BEFORE they are signed (HMAC-SHA256) and persisted to immutable audit logs.
 *
 * Supported PII types (built-in):
 * - CPF (with checksum validation)
 * - CNPJ (with checksum validation)
 * - Credit/Debit Cards (Luhn algorithm)
 * - Email addresses
 * - Phone numbers (BR format)
 * - Bank account patterns
 * - CEP (postal codes)
 * - RG (identity document)
 * - PIX keys
 *
 * FASE 4b additions:
 * - `sanitizeWithRules({ text, orgId, assistantId })` — loads org-specific rules
 *   from DB (Redis-cached, 5-min TTL) and dispatches mask/block/alert per rule.
 * - Policy-exception downgrade: active exceptions for PII/sensitive-data topics
 *   downgrade block/mask → alert.
 * - Backward-compat: `sanitize(text)` continues to work as a synchronous fallback.
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

// ── FASE 4b ─────────────────────────────────────────────────────────────────

export interface DlpSanitizeInput {
    text: string;
    orgId: string;
    assistantId: string;
}

export interface DlpDetection {
    rule_id: string;
    rule_name: string;
    detector_type: string;
    pattern_matched: string;
    action_taken: 'mask' | 'block' | 'alert';
}

export interface DlpSanitizeResult {
    sanitized_text: string;
    blocked: boolean;
    block_reason?: string;
    detections: DlpDetection[];
}

interface DbDlpRule {
    id: string;
    name: string;
    detector_type: 'builtin' | 'regex' | 'keyword_list';
    pattern: string | null;
    pattern_config: Record<string, unknown>;
    action: 'mask' | 'block' | 'alert';
    applies_to: string[];
    is_active: boolean;
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
// Built-in PII Detectors
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
 * Phone detector — requires formatting markers (parentheses, +55, dashes)
 * OR contextual keywords (tel, telefone, celular, whatsapp, contato)
 * to avoid false positives on bare digit sequences.
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
        // Context-aware detection for unformatted phones
        const contextPattern = /\b(tel(?:efone)?|celular|whatsapp|contato|fone)\s*:?\s*(\d{10,11})\b/gi;
        let cm;
        while ((cm = contextPattern.exec(text)) !== null) {
            const overlap = detections.some(d =>
                d.startIndex <= cm!.index && d.endIndex >= cm!.index + cm![0].length
            );
            if (!overlap) {
                detections.push({
                    type: 'PHONE', original: cm[0], masked: '[PHONE_REDACTED]',
                    startIndex: cm.index, endIndex: cm.index + cm[0].length, confidence: 'MEDIUM'
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

/**
 * PIX Key detector — requires explicit PIX context keyword before the value.
 */
const pixKeyDetector: PIIDetector = {
    type: 'PIX_KEY',
    detect(text: string): PIIDetection[] {
        const detections: PIIDetection[] = [];
        const pattern = /\b(?:chave\s+pix|via\s+pix|pix)\s*:?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{11,14}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            detections.push({
                type: 'PIX_KEY',
                original: m[0],
                masked: '[PIX_KEY_REDACTED]',
                startIndex: m.index,
                endIndex: m.index + m[0].length,
                confidence: 'HIGH',
            });
        }
        return detections;
    }
};

// ---------------------------------------------------------------------------
// Builtin detector map (used by sanitizeWithRules for 'builtin' type)
// ---------------------------------------------------------------------------

const BUILTIN_DETECTORS: Record<string, PIIDetector> = {
    CPF:         cpfDetector,
    CNPJ:        cnpjDetector,
    CREDIT_CARD: creditCardDetector,
    EMAIL:       emailDetector,
    PHONE:       phoneDetector,
    BANK_ACCOUNT: bankAccountDetector,
    CEP:         cepDetector,
    RG:          rgDetector,
    PIX_KEY:     pixKeyDetector,
    // PERSON is Presidio-only — handled via sanitizeSemanticNLP, mapped to alert only
};

// ---------------------------------------------------------------------------
// DLP Engine
// ---------------------------------------------------------------------------

export class DLPEngine {
    private detectors: PIIDetector[];

    constructor() {
        this.detectors = [
            pixKeyDetector, cpfDetector, cnpjDetector, creditCardDetector, emailDetector,
            phoneDetector, bankAccountDetector, cepDetector, rgDetector,
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

    /**
     * Deep sanitize all string values in a nested object.
     * Async: delegates to sanitizeSemanticNLP (Tier 1 regex + Tier 2 Presidio NLP).
     * Falls back to Tier 1 regex when Presidio is unavailable.
     */
    async sanitizeObject(obj: any): Promise<{ sanitized: any; totalDetections: number }> {
        let total = 0;
        const recurse = async (v: any): Promise<any> => {
            if (typeof v === 'string') {
                const r = await this.sanitizeSemanticNLP(v);
                total += r.detections.length;
                return r.sanitizedText;
            }
            if (Array.isArray(v)) return Promise.all(v.map(recurse));
            if (v !== null && typeof v === 'object') {
                const o: any = {};
                for (const k of Object.keys(v)) o[k] = await recurse(v[k]);
                return o;
            }
            return v;
        };
        return { sanitized: await recurse(obj), totalDetections: total };
    }

    /**
     * Tier 2 Semantic NLP Scanner (Microsoft Presidio).
     * Offloads contextual detection to an external Python/ML microservice.
     */
    async sanitizeSemanticNLP(text: string): Promise<SanitizationResult> {
        const localSanitized = this.sanitize(text);
        const presidioUrl = process.env.PRESIDIO_URL || 'http://localhost:5001/analyze';
        try {
            const axios = require('axios');
            const response = await axios.post(presidioUrl, { text: localSanitized.sanitizedText, language: 'pt' });
            const presidioDetections = response.data.detections || [];
            const mergedDetections = [...localSanitized.detections, ...presidioDetections];
            return {
                sanitizedText: response.data.sanitized_text || localSanitized.sanitizedText,
                detections: mergedDetections,
                hasPII: localSanitized.hasPII || response.data.has_pii || presidioDetections.length > 0
            };
        } catch {
            console.warn('[DLP NLP] Presidio Semantic API unavailable. Falling back to Tier 1 Regex.');
            return localSanitized;
        }
    }

    // ── FASE 4b ──────────────────────────────────────────────────────────────

    /**
     * Load org DLP rules from DB (Redis-cached, 5-min TTL).
     * Falls back to empty array on any error (backward-compat: behaves like pre-4b).
     */
    private async loadOrgRules(orgId: string): Promise<DbDlpRule[]> {
        const cacheKey = `dlp_rules:${orgId}`;
        try {
            const { redisCache } = require('./redis');
            const cached = await redisCache.get(cacheKey);
            if (cached) {
                return JSON.parse(cached) as DbDlpRule[];
            }
        } catch {
            // Redis unavailable — proceed to DB
        }

        try {
            const { pgPool } = require('./db');
            const client = await pgPool.connect();
            try {
                await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                const result = await client.query(
                    `SELECT id, name, detector_type, pattern, pattern_config, action, applies_to, is_active
                     FROM dlp_rules
                     WHERE org_id = $1 AND is_active = true
                     ORDER BY is_system DESC, created_at ASC`,
                    [orgId]
                );
                const rules: DbDlpRule[] = result.rows.map((r: any) => ({
                    ...r,
                    pattern_config: r.pattern_config || {},
                    applies_to: r.applies_to || [],
                }));
                try {
                    const { redisCache } = require('./redis');
                    await redisCache.set(cacheKey, JSON.stringify(rules), 'EX', 300);
                } catch {
                    // Redis unavailable
                }
                return rules;
            } finally {
                client.release();
            }
        } catch (e) {
            console.warn('[DLP] Could not load org rules from DB, using builtin-only fallback:', (e as Error).message);
            return [];
        }
    }

    /**
     * Check if any active policy exception for this assistant downgrades DLP enforcement.
     * Exception types that trigger downgrade: allow_sensitive_data, allow_pii_processing, allow_financial_data.
     */
    private async hasActivePiiException(orgId: string, assistantId: string): Promise<boolean> {
        if (!assistantId) return false;
        try {
            const { pgPool } = require('./db');
            const client = await pgPool.connect();
            try {
                await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                const result = await client.query(
                    `SELECT 1 FROM policy_exceptions
                     WHERE org_id = $1
                       AND (assistant_id = $2 OR assistant_id IS NULL)
                       AND status = 'active'
                       AND exception_type IN ('allow_sensitive_data', 'allow_pii_processing', 'allow_financial_data')
                       AND (expires_at IS NULL OR expires_at > NOW())
                     LIMIT 1`,
                    [orgId, assistantId]
                );
                return result.rows.length > 0;
            } finally {
                client.release();
            }
        } catch {
            return false;
        }
    }

    /**
     * FASE 4b — Context-aware DLP sanitization.
     *
     * 1. If no org rules in DB → fall back to legacy `sanitize(text)` behavior (REGRA 3).
     * 2. Load active rules, filter by `applies_to` for the given assistant.
     * 3. Check policy exceptions → downgrade block/mask → alert when active.
     * 4. Apply each rule in order: block (highest priority), then mask, then alert.
     * 5. Return DlpSanitizeResult with sanitized text, blocked flag, and detections list.
     */
    async sanitizeWithRules(input: DlpSanitizeInput): Promise<DlpSanitizeResult> {
        const { text, orgId, assistantId } = input;

        const orgRules = await this.loadOrgRules(orgId);

        // REGRA 3: No custom rules → behave exactly like legacy sanitize()
        if (orgRules.length === 0) {
            const legacy = this.sanitize(text);
            return {
                sanitized_text: legacy.sanitizedText,
                blocked: false,
                detections: legacy.detections.map(d => ({
                    rule_id: 'builtin',
                    rule_name: d.type,
                    detector_type: 'builtin',
                    pattern_matched: d.original,
                    action_taken: 'mask' as const,
                })),
            };
        }

        // Check policy exceptions for this assistant
        const hasPiiException = await this.hasActivePiiException(orgId, assistantId);

        // Filter rules applicable to this assistant
        const applicableRules = orgRules.filter(rule => {
            if (!Array.isArray(rule.applies_to) || rule.applies_to.length === 0) return true;
            return rule.applies_to.includes(assistantId);
        });

        const allDetections: DlpDetection[] = [];
        let workingText = text;
        let blocked = false;
        let blockReason: string | undefined;

        // Sort: block rules first, then mask, then alert (descending priority)
        const priorityOrder = { block: 0, mask: 1, alert: 2 };
        const sortedRules = [...applicableRules].sort((a, b) => {
            const effA = hasPiiException && a.action !== 'alert' ? 2 : priorityOrder[a.action];
            const effB = hasPiiException && b.action !== 'alert' ? 2 : priorityOrder[b.action];
            return effA - effB;
        });

        for (const rule of sortedRules) {
            // Determine effective action (downgrade if policy exception active)
            const effectiveAction: 'mask' | 'block' | 'alert' =
                hasPiiException && rule.action !== 'alert' ? 'alert' : rule.action;

            const matches = this.matchRule(workingText, rule);
            if (matches.length === 0) continue;

            for (const match of matches) {
                allDetections.push({
                    rule_id: rule.id,
                    rule_name: rule.name,
                    detector_type: rule.detector_type,
                    pattern_matched: match,
                    action_taken: effectiveAction,
                });
            }

            if (effectiveAction === 'block') {
                blocked = true;
                blockReason = `Regra DLP "${rule.name}" bloqueou a mensagem.`;
                // Return immediately — no need to process further
                return {
                    sanitized_text: text, // Return original (blocked, not sent)
                    blocked: true,
                    block_reason: blockReason,
                    detections: allDetections,
                };
            }

            if (effectiveAction === 'mask') {
                workingText = this.applyMask(workingText, rule, matches);
            }
            // 'alert': no text change, detection recorded above
        }

        return {
            sanitized_text: workingText,
            blocked,
            block_reason: blockReason,
            detections: allDetections,
        };
    }

    /**
     * Find all matches in `text` for the given DB rule.
     * Returns array of matched substrings.
     */
    private matchRule(text: string, rule: DbDlpRule): string[] {
        const matches: string[] = [];

        if (rule.detector_type === 'builtin') {
            const detector = BUILTIN_DETECTORS[rule.pattern ?? ''];
            if (!detector) return matches;
            const detections = detector.detect(text);
            for (const d of detections) matches.push(d.original);
            return matches;
        }

        if (rule.detector_type === 'regex' && rule.pattern) {
            try {
                const flags = (rule.pattern_config?.flags as string) || 'gi';
                const re = new RegExp(rule.pattern, flags);
                let m: RegExpExecArray | null;
                while ((m = re.exec(text)) !== null) {
                    matches.push(m[0]);
                    // Prevent infinite loop on zero-length matches
                    if (m[0].length === 0) re.lastIndex++;
                }
            } catch {
                // Invalid regex — skip silently
            }
            return matches;
        }

        if (rule.detector_type === 'keyword_list') {
            const keywords: string[] = (rule.pattern_config?.keywords as string[]) || [];
            for (const kw of keywords) {
                if (!kw) continue;
                try {
                    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
                    let m: RegExpExecArray | null;
                    while ((m = re.exec(text)) !== null) {
                        matches.push(m[0]);
                    }
                } catch {
                    // Invalid keyword — skip
                }
            }
            return matches;
        }

        return matches;
    }

    /**
     * Apply mask replacement for all matches of the rule in the text.
     */
    private applyMask(text: string, rule: DbDlpRule, matches: string[]): string {
        let result = text;
        const redactLabel = `[${rule.name.toUpperCase().replace(/\s+/g, '_')}_REDACTED]`;

        // Build a combined regex from all unique match strings
        const uniqueMatches = [...new Set(matches)];
        for (const match of uniqueMatches) {
            try {
                const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(escaped, 'g');
                result = result.replace(re, redactLabel);
            } catch {
                // Skip on error
            }
        }
        return result;
    }
}

export const dlpEngine = new DLPEngine();
