/**
 * DLP scanner for ingested documents — FASE 14.0/6a₁
 * ---------------------------------------------------------------------------
 * Brazilian-PT/EN regex layer that runs on the FULL extracted text of an
 * uploaded document before chunking + embedding. Distinct from the
 * existing src/lib/dlp-engine.ts (which targets short prompts and runs
 * during /v1/execute) because:
 *
 *   1. Documents are 100x larger than chat prompts; running the
 *      Presidio NLP path on every upload would be prohibitively slow
 *      and unnecessary (most blocks are decided by simple ID patterns).
 *   2. The action policy is different: /v1/execute may MASK and
 *      proceed (sanitized message reaches the LLM); for documents we
 *      either ALLOW (no PII) or BLOCK (sensitive IDs) — partial
 *      masking would create chunks of mixed sensitivity that the
 *      retrieval layer can't reason about.
 *
 * Block triggers (any one is enough):
 *   - 1+ CPF
 *   - 1+ CNPJ (commercial taxpayer ID — same blocking-rule for now)
 *   - 1+ credit-card-shaped 16-digit sequence
 *
 * Redact triggers (logged but allowed):
 *   - emails (common in business docs; blocking would reject too many)
 *   - phone numbers (BR format)
 *
 * No-PII documents pass with hits=[] and action='allow'.
 */

const PATTERNS: Record<string, RegExp> = {
    cpf:        /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    cnpj:       /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
    credit_card:/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    email:      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    phone_br:   /\b(?:\+?55)?[\s-]?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g,
};

const BLOCK_TYPES = new Set(['cpf', 'cnpj', 'credit_card']);

export interface DLPDocumentHit {
    type: string;
    count: number;
    samples: string[]; // first 3, partially masked
}

export interface DLPDocumentResult {
    has_pii: boolean;
    hits: DLPDocumentHit[];
    action: 'allow' | 'redact' | 'block';
}

function maskSample(s: string): string {
    if (s.length <= 4) return '***';
    return s.substring(0, 4) + '***';
}

export function scanDocumentForPII(text: string): DLPDocumentResult {
    const hits: DLPDocumentHit[] = [];
    for (const [type, pattern] of Object.entries(PATTERNS)) {
        // RegExp with /g must be reset between calls because match() reuses lastIndex.
        const matches = text.match(new RegExp(pattern.source, pattern.flags)) ?? [];
        if (matches.length > 0) {
            hits.push({
                type,
                count: matches.length,
                samples: matches.slice(0, 3).map(maskSample),
            });
        }
    }

    let action: DLPDocumentResult['action'] = 'allow';
    if (hits.some(h => BLOCK_TYPES.has(h.type))) {
        action = 'block';
    } else if (hits.length > 0) {
        action = 'redact';
    }

    return {
        has_pii: hits.length > 0,
        hits,
        action,
    };
}
