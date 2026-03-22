/**
 * Shield Executive Report
 *
 * Gera relatório executivo de postura de risco Shield para uma org.
 * Persiste o relatório em shield_executive_reports.
 *
 * REGRAS:
 *   - set_config(..., false) — session-level
 *   - Limpar set_config no finally
 */

import { Pool } from 'pg';
import { calculateOrgRiskPosture } from './shield-risk-engine';

export interface ExecutiveReportData {
    org: { id: string; name: string };
    period: { start: Date; end: Date };
    posture: {
        overallScore: number;
        severityLabel: string;
        criticalCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
    };
    topTools: Array<{ toolName: string; score: number; severity: string }>;
    totalObservations: number;
    uniqueUsersAffected: number;
    recommendations: string[];
    generatedAt: Date;
}

/**
 * Gera e persiste o relatório executivo de risco Shield.
 *
 * @param orgId        UUID da organização
 * @param generatedBy  userId do solicitante (para auditoria)
 */
export async function generateExecutiveReport(
    pgPool: Pool,
    orgId: string,
    generatedBy: string
): Promise<ExecutiveReportData> {
    const client = await pgPool.connect();
    try {
        // REGRA: false (session-level), não true (transaction-local)
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );

        const orgResult = await client.query(
            'SELECT id, name FROM organizations WHERE id = $1', [orgId]
        );
        if (orgResult.rows.length === 0) {
            throw new Error(`Organization ${orgId} not found`);
        }
        const org = orgResult.rows[0] as { id: string; name: string };

        // Período: últimos 30 dias
        const periodEnd   = new Date();
        const periodStart = new Date();
        periodStart.setDate(periodStart.getDate() - 30);

        // Postura de risco via risk engine
        const posture = await calculateOrgRiskPosture(pgPool, orgId);

        const severityLabel =
            posture.overallScore >= 85 ? 'Crítico'      :
            posture.overallScore >= 70 ? 'Alto'          :
            posture.overallScore >= 50 ? 'Médio'         :
            posture.overallScore >= 30 ? 'Baixo'         : 'Informacional';

        // Contagem de observações e usuários únicos no período
        const obsResult = await client.query(
            `SELECT
               COUNT(*)::int                          AS total,
               COUNT(DISTINCT user_identifier_hash)::int AS unique_users
             FROM shield_observations_raw
             WHERE org_id = $1 AND created_at >= $2`,
            [orgId, periodStart]
        );

        // Recomendações dinâmicas baseadas nos dados reais
        const recommendations: string[] = [];
        if (posture.criticalCount > 0)
            recommendations.push(
                `${posture.criticalCount} ferramenta(s) de risco crítico requerem ação imediata.`
            );
        if (posture.highCount > 0)
            recommendations.push(
                `Iniciar catalogação para ${posture.highCount} ferramenta(s) de alto risco.`
            );
        if (recommendations.length === 0)
            recommendations.push('Nenhuma ação crítica pendente. Manter monitoramento.');

        // Persistir relatório para auditoria
        await client.query(
            `INSERT INTO shield_executive_reports
             (org_id, period_start, period_end, summary_json, generated_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                orgId,
                periodStart,
                periodEnd,
                JSON.stringify({
                    overallScore:  posture.overallScore,
                    severityLabel,
                    criticalCount: posture.criticalCount,
                    highCount:     posture.highCount,
                    mediumCount:   posture.mediumCount,
                    lowCount:      posture.lowCount,
                }),
                generatedBy,
            ]
        );

        return {
            org: { id: org.id, name: org.name },
            period: { start: periodStart, end: periodEnd },
            posture: {
                overallScore:  posture.overallScore,
                severityLabel,
                criticalCount: posture.criticalCount,
                highCount:     posture.highCount,
                mediumCount:   posture.mediumCount,
                lowCount:      posture.lowCount,
            },
            topTools:            posture.topTools,
            totalObservations:   obsResult.rows[0]?.total         ?? 0,
            uniqueUsersAffected: obsResult.rows[0]?.unique_users  ?? 0,
            recommendations,
            generatedAt: new Date(),
        };
    } finally {
        // Limpar SEMPRE no finally
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
