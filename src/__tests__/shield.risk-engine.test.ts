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

    // T9: total score sancionado < não sancionado (mesmo input)
    it('T9: total score de ferramenta sancionada < não sancionada (mesmo perfil)', () => {
        const base = {
            toolBaseRisk:     12,
            dataExposureRisk: 12,
            observationCount: 30,
            uniqueUsers:      15,
            signalSources:    ['oauth', 'network'] as string[],
        };
        const unsanctioned = calculateRiskScore({ ...base, isSanctioned: false });
        const sanctioned   = calculateRiskScore({ ...base, isSanctioned: true });

        expect(sanctioned.total).toBeLessThan(unsanctioned.total);
    });

    // T10: score é determinístico para mesmo input
    it('T10: mesmo input produz score idêntico em chamadas consecutivas', () => {
        const input = {
            toolBaseRisk:     8,
            dataExposureRisk: 12,
            scopes:           ['Mail.Read'],
            observationCount: 25,
            uniqueUsers:      7,
            isSanctioned:     false,
            isKnownTool:      true,
            signalSources:    ['oauth'],
        };

        const r1 = calculateRiskScore(input);
        const r2 = calculateRiskScore(input);

        expect(r1.total).toBe(r2.total);
        expect(r1.severity).toBe(r2.severity);
        expect(r1.dimensions.baseRisk).toBe(r2.dimensions.baseRisk);
        expect(r1.dimensions.exposure).toBe(r2.dimensions.exposure);
    });

    // T11: recommendedAction não é nulo e tem valor válido
    it('T11: recommendedAction retornado e válido para todos os níveis de risco', () => {
        const validActions = ['restrict_and_catalog', 'catalog_and_review', 'monitor', 'observe'];

        const critical = calculateRiskScore({
            toolBaseRisk:     20,
            dataExposureRisk: 20,
            scopes:           ['Mail.Read', 'Files.ReadWrite.All'],
            observationCount: 200,
            uniqueUsers:      50,
            isSanctioned:     false,
            isKnownTool:      false,
            signalSources:    ['oauth', 'network', 'browser'],
        });
        expect(validActions).toContain(critical.recommendedAction);

        const low = calculateRiskScore({
            toolBaseRisk: 2, dataExposureRisk: 0, uniqueUsers: 1,
            isSanctioned: true, signalSources: ['manual'],
        });
        expect(validActions).toContain(low.recommendedAction);

        // Alto risco → restrict_and_catalog
        expect(critical.recommendedAction).toBe('restrict_and_catalog');
        // Baixo risco → observe
        expect(low.recommendedAction).toBe('observe');

        // scoreVersion sempre '1.1'
        expect(critical.scoreVersion).toBe('1.1');
        expect(low.scoreVersion).toBe('1.1');
    });

});
