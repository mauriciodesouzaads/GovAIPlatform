/**
 * Model bias scoring — FASE 13.1
 * ---------------------------------------------------------------------------
 * Fairness metrics for AI assistant versions. Deterministic: given the same
 * inputs the function returns identical outputs, which is a hard requirement
 * for auditor reproducibility (EU AI Act Art. 10 / LGPD Art. 20).
 *
 * Metrics implemented:
 *   - demographic_parity: max_pairwise |P(y^=1|A=i) - P(y^=1|A=j)|
 *                         → 0 when positive-prediction rates are equal across groups
 *   - statistical_parity: same as demographic_parity (binary signed is the same
 *                         number for 2-group cohorts; we expose both so the UI
 *                         can label one as the "signed" view).
 *   - disparate_impact:   min(positive_rate) / max(positive_rate)
 *                         → the "80% rule" from US EEOC: fail if < 0.8.
 *   - equalized_odds:     max(TPR_diff, FPR_diff) across groups
 *                         Requires TPR/FPR-computable inputs (TP, FN, FP, TN).
 *
 * Input shape (per group):
 *   { "gender=F": { n: 500, predicted_positive: 120,
 *                   true_positive: 100, false_positive: 20,
 *                   true_negative: 370, false_negative: 10 } }
 * The confusion-matrix fields are optional; if missing, equalized_odds is
 * simply not computed (the metric is reported as undefined, not zero).
 *
 * Verdict:
 *   pass  — no threshold violations
 *   warn  — exactly one violation (actionable signal, not a gate)
 *   fail  — two or more violations (blocks publication if the gate is on)
 */

export interface GroupStats {
    n: number;
    predicted_positive: number;
    true_positive?: number;
    false_positive?: number;
    true_negative?: number;
    false_negative?: number;
}

export interface BiasThresholds {
    demographic_parity_max: number;   // default 0.1
    equalized_odds_max: number;        // default 0.1
    disparate_impact_min: number;      // default 0.8
    disparate_impact_max: number;      // default 1.25
}

export interface BiasMetrics {
    demographic_parity?: number;
    equalized_odds?: number;
    disparate_impact?: number;
    statistical_parity?: number;
}

export interface GroupBreakdown extends GroupStats {
    positive_rate: number;
    tpr?: number;
    fpr?: number;
}

export interface BiasResult {
    metrics: BiasMetrics;
    verdict: 'pass' | 'warn' | 'fail';
    violations: string[];
    group_breakdowns: Record<string, GroupBreakdown>;
}

export const DEFAULT_THRESHOLDS: BiasThresholds = {
    demographic_parity_max: 0.1,
    equalized_odds_max: 0.1,
    disparate_impact_min: 0.8,
    disparate_impact_max: 1.25,
};

/**
 * Round to 4 decimal places. Centralized so every metric uses the same
 * precision — important because the `numeric(6,4)` column in postgres
 * truncates silently beyond that.
 */
function round4(x: number): number {
    return Number(x.toFixed(4));
}

export function computeBias(
    groups: Record<string, GroupStats>,
    thresholds: BiasThresholds = DEFAULT_THRESHOLDS,
): BiasResult {
    const groupKeys = Object.keys(groups);
    if (groupKeys.length < 2) {
        throw new Error('Need at least 2 groups to compute bias metrics');
    }
    for (const key of groupKeys) {
        const g = groups[key];
        if (!Number.isFinite(g.n) || g.n <= 0) {
            throw new Error(`Group '${key}' has invalid sample size n=${g.n}`);
        }
        if (!Number.isFinite(g.predicted_positive) || g.predicted_positive < 0) {
            throw new Error(`Group '${key}' has invalid predicted_positive=${g.predicted_positive}`);
        }
        if (g.predicted_positive > g.n) {
            throw new Error(`Group '${key}' predicted_positive (${g.predicted_positive}) exceeds n (${g.n})`);
        }
    }

    // ── Per-group breakdowns (enriched with derived rates) ──────────────────
    const breakdowns: Record<string, GroupBreakdown> = {};
    for (const [key, g] of Object.entries(groups)) {
        const positive_rate = g.n > 0 ? g.predicted_positive / g.n : 0;
        const tpr = (g.true_positive !== undefined && g.false_negative !== undefined)
            ? g.true_positive / Math.max(1, g.true_positive + g.false_negative)
            : undefined;
        const fpr = (g.false_positive !== undefined && g.true_negative !== undefined)
            ? g.false_positive / Math.max(1, g.false_positive + g.true_negative)
            : undefined;
        breakdowns[key] = { ...g, positive_rate, tpr, fpr };
    }

    // ── Metrics ─────────────────────────────────────────────────────────────
    const positiveRates = groupKeys.map(k => breakdowns[k].positive_rate);
    const min_rate = Math.min(...positiveRates);
    const max_rate = Math.max(...positiveRates);

    // Demographic parity = max_pairwise positive-rate gap
    const demographic_parity = max_rate - min_rate;

    // Statistical parity = same numeric value for binary/k-group cohorts;
    // kept as separate field so the UI can phrase it as signed/unsigned.
    const statistical_parity = demographic_parity;

    // Disparate impact = ratio of smallest to largest positive rate.
    // Defined as 1 when the maximum is 0 (no positives anywhere → no bias).
    const disparate_impact = max_rate > 0 ? min_rate / max_rate : 1;

    // Equalized odds (max TPR/FPR spread across groups) — only when ALL
    // groups expose the confusion-matrix fields.
    let equalized_odds: number | undefined;
    const tprs = groupKeys.map(k => breakdowns[k].tpr);
    const fprs = groupKeys.map(k => breakdowns[k].fpr);
    const tprsDefined = tprs.filter((v): v is number => v !== undefined);
    const fprsDefined = fprs.filter((v): v is number => v !== undefined);
    if (tprsDefined.length === groupKeys.length && fprsDefined.length === groupKeys.length) {
        const tprDiff = Math.max(...tprsDefined) - Math.min(...tprsDefined);
        const fprDiff = Math.max(...fprsDefined) - Math.min(...fprsDefined);
        equalized_odds = Math.max(tprDiff, fprDiff);
    }

    // ── Verdict ─────────────────────────────────────────────────────────────
    const violations: string[] = [];
    if (demographic_parity > thresholds.demographic_parity_max) {
        violations.push(
            `demographic_parity=${round4(demographic_parity)} > ${thresholds.demographic_parity_max}`,
        );
    }
    if (equalized_odds !== undefined && equalized_odds > thresholds.equalized_odds_max) {
        violations.push(
            `equalized_odds=${round4(equalized_odds)} > ${thresholds.equalized_odds_max}`,
        );
    }
    if (
        disparate_impact < thresholds.disparate_impact_min
        || disparate_impact > thresholds.disparate_impact_max
    ) {
        violations.push(
            `disparate_impact=${round4(disparate_impact)} outside [${thresholds.disparate_impact_min}, ${thresholds.disparate_impact_max}]`,
        );
    }

    const verdict: 'pass' | 'warn' | 'fail' =
        violations.length === 0 ? 'pass'
            : violations.length <= 1 ? 'warn'
                : 'fail';

    return {
        metrics: {
            demographic_parity: round4(demographic_parity),
            equalized_odds: equalized_odds !== undefined ? round4(equalized_odds) : undefined,
            disparate_impact: round4(disparate_impact),
            statistical_parity: round4(statistical_parity),
        },
        verdict,
        violations,
        group_breakdowns: breakdowns,
    };
}
