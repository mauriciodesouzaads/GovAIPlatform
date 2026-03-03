import { loadPolicy } from '@open-policy-agent/opa-wasm';
import { dlpEngine, SanitizationResult } from './dlp-engine';

export interface GovernanceDecision {
    allowed: boolean;
    reason?: string;
    action?: 'BLOCK' | 'FLAG' | 'ALLOW';
    /** When PII is detected, this contains the sanitized (masked) version of the input */
    sanitizedInput?: string;
    /** DLP detection report for audit enrichment */
    dlpReport?: {
        totalDetections: number;
        types: string[];
    };
}

export class OpaGovernanceEngine {
    private opaIns: any = null;

    // In a real environment, this WASM or Rego policy would be loaded dynamically from a database or storage
    // For this example, we'll demonstrate the architecture using a mock that behaves like the OPA evaluation

    async initialize(policyWasmBuffer?: Buffer) {
        if (policyWasmBuffer) {
            this.opaIns = await loadPolicy(policyWasmBuffer);
        }
    }

    async evaluate(input: any, policyContext: any): Promise<GovernanceDecision> {
        // Fallback or demonstration logic matching what OPA would do based on OPA rules
        if (this.opaIns != null) {
            const resultSet = this.opaIns.evaluate({ input, ...policyContext });
            const result = resultSet[0]?.result;

            if (result && !result.allow) {
                return {
                    allowed: false,
                    reason: result.reason || "Bloqueado por Política OPA Corporativa",
                    action: result.action || 'BLOCK'
                };
            }
            return { allowed: true, action: 'ALLOW' };
        }

        // --- MOCK OPA BEHAVIOR FOR REFINEMENT ---
        // If no WASM is loaded, we simulate the OPA engine evaluating the Rego rules locally

        const text = (input.message || '').toLowerCase();

        // 1. OPA Rule: DLP Semantic PII Detection (replaces naive regex)
        if (policyContext?.rules?.pii_filter) {
            const dlpResult: SanitizationResult = dlpEngine.sanitize(input.message || '');

            if (dlpResult.hasPII) {
                const detectedTypes = [...new Set(dlpResult.detections.map(d => d.type))];

                // FLAG + sanitize instead of blocking — the pipeline continues with masked input
                return {
                    allowed: true,               // Allow the request to proceed
                    action: 'FLAG',               // Mark as flagged for audit
                    reason: `DLP: PII detectado e mascarado (${detectedTypes.join(', ')})`,
                    sanitizedInput: dlpResult.sanitizedText,
                    dlpReport: {
                        totalDetections: dlpResult.detections.length,
                        types: detectedTypes
                    }
                };
            }
        }

        // 2. OPA Rule: Topic blacklisting
        const forbiddenTopics = policyContext?.rules?.forbidden_topics || [];
        for (const topic of forbiddenTopics) {
            if (text.includes(topic.toLowerCase())) {
                return { allowed: false, reason: `Bloqueado pela Política (OPA): Assunto proibido detectado (${topic})`, action: 'BLOCK' }
            }
        }

        // 3. OPA Rule: Jailbreak / Prompt Injection Prevention
        const bypassPhrases = ["ignore previous", "admin mode", "bypass"];
        if (bypassPhrases.some(p => text.includes(p))) {
            return { allowed: false, reason: `Bloqueado pela Política (OPA): Tentativa de Evasão de Regras`, action: 'BLOCK' }
        }

        return { allowed: true, action: 'ALLOW' };
    }
}

// Export singleton instance for app-wide usage
export const opaEngine = new OpaGovernanceEngine();
