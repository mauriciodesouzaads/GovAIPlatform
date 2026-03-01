"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.opaEngine = exports.OpaGovernanceEngine = void 0;
const opa_wasm_1 = require("@open-policy-agent/opa-wasm");
class OpaGovernanceEngine {
    constructor() {
        this.opaIns = null;
    }
    // In a real environment, this WASM or Rego policy would be loaded dynamically from a database or storage
    // For this example, we'll demonstrate the architecture using a mock that behaves like the OPA evaluation
    async initialize(policyWasmBuffer) {
        if (policyWasmBuffer) {
            this.opaIns = await (0, opa_wasm_1.loadPolicy)(policyWasmBuffer);
        }
    }
    async evaluate(input, policyContext) {
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
        // 1. OPA Rule: Block sensitive information (Mocked logic)
        const piiRegex = /\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b/;
        if (policyContext?.rules?.pii_filter && piiRegex.test(text)) {
            return { allowed: false, reason: "Bloqueado pela Política (OPA): PII/CPF  Identificado", action: 'BLOCK' };
        }
        // 2. OPA Rule: Topic blacklisting
        const forbiddenTopics = policyContext?.rules?.forbidden_topics || [];
        for (const topic of forbiddenTopics) {
            if (text.includes(topic.toLowerCase())) {
                return { allowed: false, reason: `Bloqueado pela Política (OPA): Assunto proibido detectado (${topic})`, action: 'BLOCK' };
            }
        }
        // 3. OPA Rule: Jailbreak / Prompt Injection Prevention
        const bypassPhrases = ["ignore previous", "admin mode", "bypass"];
        if (bypassPhrases.some(p => text.includes(p))) {
            return { allowed: false, reason: `Bloqueado pela Política (OPA): Tentativa de Evasão de Regras`, action: 'BLOCK' };
        }
        return { allowed: true, action: 'ALLOW' };
    }
}
exports.OpaGovernanceEngine = OpaGovernanceEngine;
// Export singleton instance for app-wide usage
exports.opaEngine = new OpaGovernanceEngine();
