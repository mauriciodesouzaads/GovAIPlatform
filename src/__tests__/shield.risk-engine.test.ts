/**
 * shield.risk-engine.test.ts — Lógica pura, sem banco, sem I/O.
 *
 * T1–T8: calculateRiskScore, severity, promotionCandidate.
 * Nenhum teste requer DATABASE_URL.
 */

import { describe, it, expect } from 'vitest';
import { calculateRiskScore } from '../lib/shield-risk-engine';

describe('calculateRiskScore — 5 dimensões auditáveis', () => {

    // T1: score mínimo para app desconhecido com 1 uso
    it('T1: score mínimo (desconhecido, 1 uso, 1 usuário) > 0', () => {
        const result = calculateRiskScore({
            toolBaseRisk:     4,
            dataExposureRisk: 5,
            observationCount: 1,
            uniqueUsers:      1,
            isSanctioned:     false,
            isKnownTool:      false,
            signalSources:    ['manual'],
        });

        expect(result.total).toBeGreaterThan(0);
        expect(result.dimensions.baseRisk).toBeGreaterThan(0);
        expect(result.dimensions.exposure).toBeGreaterThan(0);
        expect(result.dimensions.businessContext).toBeGreaterThan(0);
        expect(result.dimensions.persistence).toBeGreaterThan(0);
        expect(result.dimensions.confidence).toBeGreaterThan(0);
    });

    // T2: scopes sensíveis (Mail.Read) aumentam exposure
    it('T2: Mail.Read em scopes aumenta exposure vs sem scopes', () => {
        const withScope = calculateRiskScore({
            dataExposureRisk: 5,
            scopes:           ['Mail.Read'],
            signalSources:    ['oauth'],
        });
        const withoutScope = calculateRiskScore({
            dataExposureRisk: 5,
            scopes:           [],
            signalSources:    ['oauth'],
        });

        expect(withScope.dimensions.exposure).toBeGreaterThan(withoutScope.dimensions.exposure);
        expect(withScope.total).toBeGreaterThan(withoutScope.total);
    });

    // T3: 50 usuários únicos → businessContext >= 18
    it('T3: 50 usuários únicos → businessContext >= 18', () => {
        const result = calculateRiskScore({ uniqueUsers: 50 });
        expect(result.dimensions.businessContext).toBeGreaterThanOrEqual(18);
    });

    // T4: ferramenta não sancionada aumenta baseRisk vs sancionada
    it('T4: isSanctioned=false aumenta baseRisk vs isSanctioned=true', () => {
        const unsanctioned = calculateRiskScore({
            toolBaseRisk: 10,
            isSanctioned: false,
        });
        const sanctioned = calculateRiskScore({
            toolBaseRisk: 10,
            isSanctioned: true,
        });

        expect(unsanctioned.dimensions.baseRisk).toBeGreaterThan(sanctioned.dimensions.baseRisk);
        expect(unsanctioned.total).toBeGreaterThan(sanctioned.total);
    });

    // T5: 3+ fontes de sinal → confidence >= 18
    it('T5: 3 signal sources → confidence >= 18', () => {
        const result = calculateRiskScore({
            signalSources: ['oauth', 'network', 'browser'],
        });
        expect(result.dimensions.confidence).toBeGreaterThanOrEqual(18);
    });

    // T6: total >= 85 → severity = 'critical'
    it('T6: severity critical quando total >= 85', () => {
        const result = calculateRiskScore({
            toolBaseRisk:     20,
            dataExposureRisk: 20,
            scopes:           ['Mail.Read', 'Files.ReadWrite.All'],
            observationCount: 200,
            uniqueUsers:      50,
            isSanctioned:     false,
            isKnownTool:      false,
            signalSources:    ['oauth', 'network', 'browser'],
        });

        expect(result.total).toBeGreaterThanOrEqual(85);
        expect(result.severity).toBe('critical');
    });

    // T7: total < 30 → severity = 'informational'
    it('T7: severity informational quando total < 30', () => {
        const result = calculateRiskScore({
            toolBaseRisk:     2,
            dataExposureRisk: 0,
            scopes:           [],
            observationCount: 1,
            uniqueUsers:      1,
            isSanctioned:     true,
            isKnownTool:      true,
            signalSources:    ['manual'],
        });

        expect(result.total).toBeLessThan(30);
        expect(result.severity).toBe('informational');
    });

    // T8: promotionCandidate = true quando score >= 50 e !isSanctioned
    it('T8: promotionCandidate = true quando score >= 50 e !isSanctioned', () => {
        const eligible = calculateRiskScore({
            toolBaseRisk:     14,
            dataExposureRisk: 14,
            observationCount: 20,
            uniqueUsers:      10,
            isSanctioned:     false,
            signalSources:    ['oauth', 'network'],
        });

        expect(eligible.total).toBeGreaterThanOrEqual(50);
        expect(eligible.promotionCandidate).toBe(true);
    });

    // Bônus: promotionCandidate = false quando sancionado (mesmo score alto)
    it('promotionCandidate = false quando isSanctioned=true', () => {
        const sanctioned = calculateRiskScore({
            toolBaseRisk:     14,
            dataExposureRisk: 14,
            observationCount: 20,
            uniqueUsers:      10,
            isSanctioned:     true,
            signalSources:    ['oauth', 'network'],
        });

        expect(sanctioned.promotionCandidate).toBe(false);
    });

});
