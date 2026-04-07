/**
 * Risk Scoring Module — deterministic, auditable risk score computation.
 *
 * Scoring matrix from govai-platform-spec.docx §5.4:
 *   Data classification:   internal=0, confidential=10, restricted=25
 *   Connector type (max):  none=0, read_only=5, read_write=15, external=20
 *   Extra connectors:      +5 per connector beyond the first
 *   PII blocker disabled:  +10 if pii_blocker=false AND classification≥confidential
 *   Output format:         free_text=+5, structured_json=0
 *
 * Thresholds:
 *   0–15   → low
 *   16–30  → medium
 *   31–50  → high
 *   51+    → critical
 *
 * Every factor includes a Portuguese explanation so an auditor can
 * verify the score without reading code.
 */

export interface RiskInput {
    data_classification: 'internal' | 'confidential' | 'restricted';
    connectors: Array<{ name: string; type: 'none' | 'read_only' | 'read_write' | 'external' }>;
    pii_blocker_enabled: boolean;
    output_format: 'free_text' | 'structured_json';
}

export interface RiskBreakdown {
    data_classification: { value: string; score: number; explanation: string };
    connector_type:      { value: string; score: number; explanation: string };
    extra_connectors:    { count: number; score: number; explanation: string };
    pii_blocker:         { enabled: boolean; score: number; explanation: string };
    output_format:       { value: string; score: number; explanation: string };
    total_score: number;
    level: 'low' | 'medium' | 'high' | 'critical';
    computed_at: string;
}

const CONNECTOR_SCORES: Record<string, number> = {
    none:       0,
    read_only:  5,
    read_write: 15,
    external:   20,
};

const CLASSIFICATION_SCORES: Record<string, number> = {
    internal:     0,
    confidential: 10,
    restricted:   25,
};

function computeLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score <= 15) return 'low';
    if (score <= 30) return 'medium';
    if (score <= 50) return 'high';
    return 'critical';
}

export function calculateRiskScore(input: RiskInput): RiskBreakdown {
    const computed_at = new Date().toISOString();

    // ── 1. Data classification ───────────────────────────────────────────────
    const classificationScore = CLASSIFICATION_SCORES[input.data_classification] ?? 0;
    const classificationExplanation: Record<string, string> = {
        internal:     `Classificação 'internal': +0 ao score (dados não-sensíveis, uso interno)`,
        confidential: `Classificação 'confidential': +10 ao score (dados não-públicos com restrição de acesso)`,
        restricted:   `Classificação 'restricted': +25 ao score (dados sensíveis — PII, segredos comerciais, dados regulados)`,
    };

    // ── 2. Connector type (highest risk among all connectors) ────────────────
    const connectors = input.connectors.filter(c => c.type !== 'none');
    let highestConnectorScore = 0;
    let highestConnectorType = 'none';

    for (const c of connectors) {
        const s = CONNECTOR_SCORES[c.type] ?? 0;
        if (s > highestConnectorScore) {
            highestConnectorScore = s;
            highestConnectorType = c.type;
        }
    }

    const connectorExplanation: Record<string, string> = {
        none:       `Nenhum conector ativo: +0 ao score`,
        read_only:  `Conector mais arriscado é 'read_only': +5 (acesso de leitura a sistemas externos)`,
        read_write: `Conector mais arriscado é 'read_write': +15 (leitura e escrita em sistemas externos — risco elevado)`,
        external:   `Conector mais arriscado é 'external': +20 (integração com sistema externo à organização — risco máximo de conector)`,
    };

    // ── 3. Extra connectors (beyond the first) ───────────────────────────────
    const extraCount = connectors.length > 1 ? connectors.length - 1 : 0;
    const extraScore = extraCount * 5;
    const extraExplanation = extraCount > 0
        ? `${connectors.length} conectores ativos (+1 extra × 5pts = +${extraScore}): cada conector adicional amplia a superfície de ataque`
        : `Apenas 1 conector ativo (ou nenhum): sem penalidade por conectores extras (+0)`;

    // ── 4. PII blocker disabled with sensitive data ──────────────────────────
    const sensitiveClasses = ['confidential', 'restricted'];
    const piiRisk = !input.pii_blocker_enabled && sensitiveClasses.includes(input.data_classification);
    const piiScore = piiRisk ? 10 : 0;
    let piiExplanation: string;
    if (piiRisk) {
        piiExplanation = `PII blocker desabilitado com dados '${input.data_classification}': +10 (risco de vazamento de dados pessoais sem mascaramento)`;
    } else if (!input.pii_blocker_enabled) {
        piiExplanation = `PII blocker desabilitado, mas classificação 'internal' não exige mascaramento: +0`;
    } else {
        piiExplanation = `PII blocker ativo: +0 (dados mascarados antes de saírem do perímetro governado)`;
    }

    // ── 5. Output format ─────────────────────────────────────────────────────
    const outputScore = input.output_format === 'free_text' ? 5 : 0;
    const outputExplanation = input.output_format === 'free_text'
        ? `Formato de output 'free_text': +5 (maior risco de exfiltração de dados em texto não estruturado)`
        : `Formato de output 'structured_json': +0 (saída estruturada permite validação e filtragem mais rigorosas)`;

    // ── Total ────────────────────────────────────────────────────────────────
    const total_score = classificationScore + highestConnectorScore + extraScore + piiScore + outputScore;
    const level = computeLevel(total_score);

    return {
        data_classification: {
            value:       input.data_classification,
            score:       classificationScore,
            explanation: classificationExplanation[input.data_classification] ?? `Classificação desconhecida: +0`,
        },
        connector_type: {
            value:       highestConnectorType,
            score:       highestConnectorScore,
            explanation: connectorExplanation[highestConnectorType] ?? `Tipo de conector desconhecido: +0`,
        },
        extra_connectors: {
            count:       extraCount,
            score:       extraScore,
            explanation: extraExplanation,
        },
        pii_blocker: {
            enabled:     input.pii_blocker_enabled,
            score:       piiScore,
            explanation: piiExplanation,
        },
        output_format: {
            value:       input.output_format,
            score:       outputScore,
            explanation: outputExplanation,
        },
        total_score,
        level,
        computed_at,
    };
}
