import { describe, it, expect } from 'vitest';
import { calculateRiskScore, RiskInput } from '../lib/risk-scoring';

function score(overrides: Partial<RiskInput> = {}): ReturnType<typeof calculateRiskScore> {
    const base: RiskInput = {
        data_classification: 'internal',
        connectors: [],
        pii_blocker_enabled: true,
        output_format: 'structured_json',
        ...overrides,
    };
    return calculateRiskScore(base);
}

describe('Risk Scoring — classification', () => {
    it('internal classification scores 0', () => {
        const r = score({ data_classification: 'internal' });
        expect(r.data_classification.score).toBe(0);
        expect(r.data_classification.value).toBe('internal');
    });

    it('confidential classification scores 10', () => {
        const r = score({ data_classification: 'confidential' });
        expect(r.data_classification.score).toBe(10);
    });

    it('restricted classification scores 25', () => {
        const r = score({ data_classification: 'restricted' });
        expect(r.data_classification.score).toBe(25);
    });
});

describe('Risk Scoring — connector type', () => {
    it('no connectors scores 0', () => {
        const r = score({ connectors: [] });
        expect(r.connector_type.score).toBe(0);
        expect(r.connector_type.value).toBe('none');
    });

    it('read_only connector scores 5', () => {
        const r = score({ connectors: [{ name: 'db', type: 'read_only' }] });
        expect(r.connector_type.score).toBe(5);
    });

    it('read_write connector scores 15', () => {
        const r = score({ connectors: [{ name: 'crm', type: 'read_write' }] });
        expect(r.connector_type.score).toBe(15);
    });

    it('external connector scores 20', () => {
        const r = score({ connectors: [{ name: 'ext', type: 'external' }] });
        expect(r.connector_type.score).toBe(20);
    });

    it('uses highest score among multiple connectors', () => {
        const r = score({
            connectors: [
                { name: 'db', type: 'read_only' },
                { name: 'crm', type: 'external' },
            ],
        });
        expect(r.connector_type.score).toBe(20);
        expect(r.connector_type.value).toBe('external');
    });
});

describe('Risk Scoring — extra connectors', () => {
    it('single connector has no extra penalty', () => {
        const r = score({ connectors: [{ name: 'db', type: 'read_only' }] });
        expect(r.extra_connectors.score).toBe(0);
        expect(r.extra_connectors.count).toBe(0);
    });

    it('3 connectors adds +10 (2 extras × 5)', () => {
        const r = score({
            connectors: [
                { name: 'a', type: 'read_only' },
                { name: 'b', type: 'read_only' },
                { name: 'c', type: 'read_only' },
            ],
        });
        expect(r.extra_connectors.count).toBe(2);
        expect(r.extra_connectors.score).toBe(10);
    });
});

describe('Risk Scoring — PII blocker', () => {
    it('PII blocker enabled: no penalty', () => {
        const r = score({ data_classification: 'confidential', pii_blocker_enabled: true });
        expect(r.pii_blocker.score).toBe(0);
    });

    it('PII blocker disabled + confidential: +10', () => {
        const r = score({ data_classification: 'confidential', pii_blocker_enabled: false });
        expect(r.pii_blocker.score).toBe(10);
    });

    it('PII blocker disabled + restricted: +10', () => {
        const r = score({ data_classification: 'restricted', pii_blocker_enabled: false });
        expect(r.pii_blocker.score).toBe(10);
    });

    it('PII blocker disabled + internal: no penalty (not sensitive)', () => {
        const r = score({ data_classification: 'internal', pii_blocker_enabled: false });
        expect(r.pii_blocker.score).toBe(0);
    });
});

describe('Risk Scoring — output format', () => {
    it('structured_json: +0', () => {
        const r = score({ output_format: 'structured_json' });
        expect(r.output_format.score).toBe(0);
    });

    it('free_text: +5', () => {
        const r = score({ output_format: 'free_text' });
        expect(r.output_format.score).toBe(5);
    });
});

describe('Risk Scoring — level thresholds', () => {
    it('score 0 → low', () => {
        const r = score();
        expect(r.level).toBe('low');
        expect(r.total_score).toBe(0);
    });

    it('score 15 → low (boundary)', () => {
        // confidential(10) + free_text(5) = 15
        const r = score({ data_classification: 'confidential', output_format: 'free_text' });
        expect(r.total_score).toBe(15);
        expect(r.level).toBe('low');
    });

    it('score 16 → medium (boundary)', () => {
        // confidential(10) + read_only(5) + free_text(5) = 20 — slightly over 15
        // Use confidential(10) + read_only(5) + free_text(5) = 20 → medium
        const r = score({
            data_classification: 'confidential',
            connectors: [{ name: 'db', type: 'read_only' }],
            output_format: 'free_text',
        });
        expect(r.total_score).toBe(20);
        expect(r.level).toBe('medium');
    });

    it('score 30 → medium (upper boundary)', () => {
        // confidential(10) + external(20) = 30
        const r = score({
            data_classification: 'confidential',
            connectors: [{ name: 'ext', type: 'external' }],
        });
        expect(r.total_score).toBe(30);
        expect(r.level).toBe('medium');
    });

    it('score 31 → high (boundary)', () => {
        // confidential(10) + external(20) + free_text(5) = 35 → high
        const r = score({
            data_classification: 'confidential',
            connectors: [{ name: 'ext', type: 'external' }],
            output_format: 'free_text',
        });
        expect(r.total_score).toBe(35);
        expect(r.level).toBe('high');
    });

    it('score 51 → critical', () => {
        // restricted(25) + external(20) + pii_off(10) = 55 → critical
        const r = score({
            data_classification: 'restricted',
            connectors: [{ name: 'ext', type: 'external' }],
            pii_blocker_enabled: false,
        });
        expect(r.total_score).toBe(55);
        expect(r.level).toBe('critical');
    });
});

describe('Risk Scoring — breakdown structure', () => {
    it('each factor has explanation string in Portuguese', () => {
        const r = score({
            data_classification: 'confidential',
            connectors: [{ name: 'db', type: 'read_write' }],
            pii_blocker_enabled: false,
            output_format: 'free_text',
        });
        expect(r.data_classification.explanation).toMatch(/confidential/);
        expect(r.connector_type.explanation).toMatch(/read_write/);
        expect(r.pii_blocker.explanation).toMatch(/PII blocker/);
        expect(r.output_format.explanation).toMatch(/free_text/);
        expect(r.computed_at).toBeTruthy();
    });

    it('total_score equals sum of all factor scores', () => {
        const r = score({
            data_classification: 'restricted',
            connectors: [
                { name: 'a', type: 'read_write' },
                { name: 'b', type: 'read_only' },
            ],
            pii_blocker_enabled: false,
            output_format: 'free_text',
        });
        const expected =
            r.data_classification.score +
            r.connector_type.score +
            r.extra_connectors.score +
            r.pii_blocker.score +
            r.output_format.score;
        expect(r.total_score).toBe(expected);
    });
});
