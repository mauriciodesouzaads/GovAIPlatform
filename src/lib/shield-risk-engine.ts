/**
 * Shield Risk Engine — Scoring de 5 Dimensões
 *
 * Calcula um risk score composto e auditável para ferramentas AI detectadas.
 * Cada dimensão vale até 20 pontos (total 0–100).
 *
 * Dimensões:
 *   1. baseRisk        — risco base do vendor/app (0-20)
 *   2. exposure        — potencial de exposição de dados (0-20)
 *   3. businessContext — amplitude organizacional (0-20)
 *   4. persistence     — frequência e volume de uso (0-20)
 *   5. confidence      — qualidade do sinal (0-20)
 *
 * isSanctioned NÃO é hardcoded — deve vir do approval_status real do banco.
 * set_config usa false (session-level) + limpeza no finally.
 */

import { Pool } from 'pg';

export type Severity = 'informational' | 'low' | 'medium' | 'high' | 'critical';

export interface RiskDimensions {
    baseRisk: number;        // 0-20: risco base do vendor, status de sanção
    exposure: number;        // 0-20: potencial de exposição (escopos OAuth, tipo de dados)
    businessContext: number; // 0-20: amplitude organizacional (usuários únicos)
    persistence: number;     // 0-20: frequência e volume de uso
    confidence: number;      // 0-20: qualidade do sinal (número de fontes)
}

export interface RiskScore {
    total: number;
    severity: Severity;
    dimensions: RiskDimensions;
    recommendation: string;
    promotionCandidate: boolean;
    recommendedAction: string;
    category: string;          // 'ai_assistant' | 'ide_plugin' | 'saas_embedded' | 'unknown'
    scoreVersion: string;      // para auditabilidade — versão do algoritmo
}

/**
 * Calcula o risk score composto de 5 dimensões.
 *
 * @param params.isSanctioned — deve vir do approval_status real do banco
 *   (approval_status === 'approved'). Nunca hardcoded como false.
 */
export function calculateRiskScore(params: {
    toolBaseRisk?: number;     // risco base do vendor (0-20)
    dataExposureRisk?: number; // risco de exposição de dados do app (0-20)
    scopes?: string[];         // OAuth scopes concedidos
    observationCount?: number; // total de observações no período
    uniqueUsers?: number;      // usuários únicos detectados
    isSanctioned?: boolean;    // approval_status === 'approved' no banco
    isKnownTool?: boolean;     // está em shield_tools com tool_id?
    signalSources?: string[];  // fontes de sinal detectadas
}): RiskScore {
    const {
        toolBaseRisk    = 10,
        dataExposureRisk = 5,
        scopes          = [],
        observationCount = 1,
        uniqueUsers     = 1,
        isSanctioned    = false,
        isKnownTool     = true,
        signalSources   = ['manual'],
    } = params;

    // ── Dimensão 1: Base Risk (0-20) ─────────────────────────────────────────
    // Combina risco base do vendor com status de aprovação na org.
    let baseRisk = Math.min(toolBaseRisk, 14);
    if (!isSanctioned) baseRisk = Math.min(baseRisk + 4, 20); // não aprovado → +4
    if (!isKnownTool)  baseRisk = Math.min(baseRisk + 6, 20); // desconhecido → +6

    // ── Dimensão 2: Exposure (0-20) ──────────────────────────────────────────
    // Escopos OAuth privilegiados aumentam significativamente o risco.
    const sensitiveScopes = [
        'Mail.Read', 'Mail.ReadWrite', 'Files.Read.All', 'Files.ReadWrite.All',
        'Calendars.ReadWrite', 'Directory.Read.All',
        'https://mail.google.com/', 'https://www.googleapis.com/auth/drive',
    ];
    let exposure = Math.min(dataExposureRisk, 10);
    if (scopes.some(s => sensitiveScopes.includes(s)))
        exposure = Math.min(exposure + 8, 20);
    else if (scopes.length > 3)
        exposure = Math.min(exposure + 4, 20);

    // ── Dimensão 3: Business Context (0-20) ──────────────────────────────────
    // Proxy: amplitude organizacional via usuários únicos.
    let businessContext = 5;
    if      (uniqueUsers >= 50) businessContext = 18;
    else if (uniqueUsers >= 20) businessContext = 14;
    else if (uniqueUsers >= 10) businessContext = 11;
    else if (uniqueUsers >= 5)  businessContext = 8;
    else if (uniqueUsers >= 2)  businessContext = 6;

    // ── Dimensão 4: Persistence (0-20) ───────────────────────────────────────
    // Frequência e volume total de observações no período.
    let persistence = 3;
    if      (observationCount >= 200) persistence = 18;
    else if (observationCount >= 50)  persistence = 14;
    else if (observationCount >= 20)  persistence = 11;
    else if (observationCount >= 10)  persistence = 8;
    else if (observationCount >= 5)   persistence = 6;

    // ── Dimensão 5: Confidence (0-20) ────────────────────────────────────────
    // Múltiplas fontes aumentam a confiança no finding.
    let confidence = 5;
    if      (signalSources.length >= 3)             confidence = 18;
    else if (signalSources.length >= 2)             confidence = 12;
    else if (signalSources.includes('oauth'))       confidence = 10;
    else if (signalSources.includes('network'))     confidence = 8;

    const total = Math.min(
        baseRisk + exposure + businessContext + persistence + confidence, 100
    );

    const severity: Severity =
        total >= 85 ? 'critical'     :
        total >= 70 ? 'high'         :
        total >= 50 ? 'medium'       :
        total >= 30 ? 'low'          : 'informational';

    const recommendation =
        total >= 70 ? 'Revisar e catalogar imediatamente. Considerar restrição de acesso.' :
        total >= 50 ? 'Catalogar e iniciar processo de governança formal.'                 :
        total >= 30 ? 'Monitorar e avaliar necessidade de catalogação.'                    :
                      'Manter monitoramento. Risco informacional.';

    const recommendedAction =
        total >= 70 ? 'restrict_and_catalog' :
        total >= 50 ? 'catalog_and_review'   :
        total >= 30 ? 'monitor'              : 'observe';

    // Inferência de categoria baseada em sinais
    const category = signalSources.includes('oauth')
        ? 'ai_assistant'
        : scopes.some(s => s.includes('drive') || s.includes('files'))
            ? 'saas_embedded'
            : 'unknown';

    return {
        total,
        severity,
        dimensions: { baseRisk, exposure, businessContext, persistence, confidence },
        recommendation,
        promotionCandidate: total >= 50 && !isSanctioned,
        recommendedAction,
        category,
        scoreVersion: '1.1',
    };
}

/**
 * Persiste o risk score calculado no shield_findings existente.
 * Sobrescreve severity com o valor calculado pelas 5 dimensões.
 */
export async function updateFindingRiskScore(
    pgPool: Pool,
    findingId: string,
    score: RiskScore
): Promise<void> {
    await pgPool.query(
        `UPDATE shield_findings
         SET risk_score          = $1,
             risk_dimensions     = $2,
             severity            = $3,
             recommendation      = $4,
             promotion_candidate = $5,
             updated_at          = NOW()
         WHERE id = $6`,
        [
            score.total,
            JSON.stringify(score.dimensions),
            score.severity,
            score.recommendation,
            score.promotionCandidate,
            findingId,
        ]
    );
}

/**
 * Calcula a postura de risco agregada de uma org para o relatório executivo.
 *
 * REGRA: set_config(..., false) — session-level, não transaction-local.
 *        Limpar no finally.
 */
export async function calculateOrgRiskPosture(
    pgPool: Pool,
    orgId: string
): Promise<{
    overallScore: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    topTools: Array<{ toolName: string; score: number; severity: string }>;
}> {
    const client = await pgPool.connect();
    try {
        // REGRA: false (session-level), não true (transaction-local)
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        const result = await client.query(
            `SELECT
               COALESCE(AVG(risk_score), 0)::int                                AS avg_score,
               COUNT(*) FILTER (WHERE severity = 'critical')                    AS critical,
               COUNT(*) FILTER (WHERE severity = 'high')                        AS high,
               COUNT(*) FILTER (WHERE severity = 'medium')                      AS medium,
               COUNT(*) FILTER (WHERE severity = 'low')                         AS low
             FROM shield_findings
             WHERE org_id = $1
               AND status IN ('open','acknowledged')`,
            [orgId]
        );

        const topTools = await client.query(
            `SELECT tool_name,
                    COALESCE(risk_score, 0) AS risk_score,
                    severity
             FROM shield_findings
             WHERE org_id = $1
               AND status IN ('open','acknowledged')
             ORDER BY risk_score DESC
             LIMIT 5`,
            [orgId]
        );

        const r = result.rows[0];
        return {
            overallScore:  r.avg_score   ?? 0,
            criticalCount: parseInt(r.critical ?? '0'),
            highCount:     parseInt(r.high     ?? '0'),
            mediumCount:   parseInt(r.medium   ?? '0'),
            lowCount:      parseInt(r.low      ?? '0'),
            topTools: topTools.rows.map(t => ({
                toolName: t.tool_name as string,
                score:    t.risk_score as number,
                severity: t.severity as string,
            })),
        };
    } finally {
        // Limpar contexto SEMPRE — mesmo em caso de erro
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
