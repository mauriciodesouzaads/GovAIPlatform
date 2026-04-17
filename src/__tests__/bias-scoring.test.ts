/**
 * Unit tests — src/lib/bias-scoring.ts
 * ---------------------------------------------------------------------------
 * Covers the deterministic fairness scorer:
 *   - balanced groups → pass
 *   - 80% rule violation → fail
 *   - equalized_odds computation when TPR/FPR derivable
 *   - input validation errors
 */

import { describe, it, expect } from 'vitest';
import { computeBias, DEFAULT_THRESHOLDS } from '../lib/bias-scoring';

describe('computeBias', () => {
    it('returns pass verdict for balanced groups', () => {
        const result = computeBias({
            'gender=M': {
                n: 500, predicted_positive: 250,
                true_positive: 200, false_positive: 50,
                true_negative: 200, false_negative: 50,
            },
            'gender=F': {
                n: 500, predicted_positive: 250,
                true_positive: 200, false_positive: 50,
                true_negative: 200, false_negative: 50,
            },
        });
        expect(result.verdict).toBe('pass');
        expect(result.violations).toHaveLength(0);
        expect(result.metrics.demographic_parity).toBeLessThanOrEqual(0.1);
        expect(result.metrics.disparate_impact).toBeCloseTo(1, 4);
    });

    it('returns fail verdict for 80% rule violation', () => {
        // 80% positive rate vs 20% → disparate_impact = 0.25, clearly failing
        const result = computeBias({
            'gender=M': { n: 500, predicted_positive: 400 },
            'gender=F': { n: 500, predicted_positive: 100 },
        });
        expect(result.verdict).toBe('fail');
        expect(result.metrics.disparate_impact).toBeLessThan(0.8);
        // At least demographic_parity + disparate_impact violations => fail
        expect(result.violations.length).toBeGreaterThanOrEqual(2);
    });

    it('throws on single group', () => {
        expect(() =>
            computeBias({ 'gender=M': { n: 100, predicted_positive: 50 } }),
        ).toThrow(/at least 2 groups/i);
    });

    it('computes equalized_odds when TPR/FPR available', () => {
        const result = computeBias({
            'A=0': {
                n: 500, predicted_positive: 200,
                true_positive: 160, false_positive: 40,
                true_negative: 260, false_negative: 40,
            },
            'A=1': {
                n: 500, predicted_positive: 210,
                true_positive: 140, false_positive: 70,
                true_negative: 230, false_negative: 60,
            },
        });
        expect(result.metrics.equalized_odds).toBeDefined();
        expect(result.metrics.equalized_odds).toBeGreaterThan(0);
        // Each breakdown exposes tpr/fpr so the UI can render the confusion matrix
        expect(result.group_breakdowns['A=0'].tpr).toBeGreaterThan(0);
        expect(result.group_breakdowns['A=0'].fpr).toBeGreaterThan(0);
    });

    it('skips equalized_odds when a group lacks confusion-matrix fields', () => {
        const result = computeBias({
            'A=0': { n: 500, predicted_positive: 240, true_positive: 200, false_positive: 40, true_negative: 220, false_negative: 40 },
            'A=1': { n: 500, predicted_positive: 250 }, // no TP/FP/TN/FN
        });
        expect(result.metrics.equalized_odds).toBeUndefined();
        expect(result.metrics.demographic_parity).toBeDefined();
    });

    it('is deterministic — identical inputs produce identical outputs', () => {
        const input = {
            'a': { n: 300, predicted_positive: 120 },
            'b': { n: 300, predicted_positive: 140 },
        };
        const r1 = computeBias(input);
        const r2 = computeBias(input);
        expect(r1).toEqual(r2);
    });

    it('rejects negative or zero sample size', () => {
        expect(() => computeBias({
            'a': { n: 0, predicted_positive: 0 },
            'b': { n: 100, predicted_positive: 50 },
        })).toThrow(/invalid sample size/i);
    });

    it('rejects predicted_positive exceeding n', () => {
        expect(() => computeBias({
            'a': { n: 100, predicted_positive: 150 },
            'b': { n: 100, predicted_positive: 50 },
        })).toThrow(/exceeds n/i);
    });

    it('marks a single violation as warn, not fail', () => {
        // Tight thresholds so exactly one metric trips, leaving verdict=warn.
        const result = computeBias(
            {
                'a': { n: 500, predicted_positive: 245 },
                'b': { n: 500, predicted_positive: 270 },
            },
            {
                demographic_parity_max: 0.04,   // 0.05 gap → violation
                equalized_odds_max: 1.0,        // not computable here
                disparate_impact_min: 0.8,      // 0.907 → ok
                disparate_impact_max: 1.25,
            },
        );
        expect(result.verdict).toBe('warn');
        expect(result.violations).toHaveLength(1);
    });

    it('uses DEFAULT_THRESHOLDS when none provided', () => {
        const result = computeBias({
            'a': { n: 100, predicted_positive: 50 },
            'b': { n: 100, predicted_positive: 50 },
        });
        // sanity: defaults expose the 80% rule interval
        expect(DEFAULT_THRESHOLDS.disparate_impact_min).toBe(0.8);
        expect(result.verdict).toBe('pass');
    });
});
