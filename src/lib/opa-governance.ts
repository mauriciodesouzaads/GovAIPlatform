import { loadPolicy } from '@open-policy-agent/opa-wasm';
import { dlpEngine, SanitizationResult } from './dlp-engine';

export interface GovernanceDecision {
    allowed: boolean;
    reason?: string;
    action?: 'BLOCK' | 'FLAG' | 'ALLOW' | 'PENDING_APPROVAL';
    /** When PII is detected, this contains the sanitized (masked) version of the input */
    sanitizedInput?: string;
    /** DLP detection report for audit enrichment */
    dlpReport?: {
        totalDetections: number;
        types: string[];
    };
}

/** High-risk keywords that trigger human review */
const HIGH_RISK_KEYWORDS = [
    'dados financeiros', 'transferência', 'transferencia',
    'excluir dados', 'deletar', 'apagar registros',
    'acesso root', 'acesso administrativo', 'acesso total',
    'produção', 'ambiente de produção',
    'dados bancários', 'dados bancarios',
    'alterar permissões', 'alterar permissoes',
    'revogar acesso', 'desativar segurança',
    'exportar banco', 'dump database',
];

export class OpaGovernanceEngine {
    private opaIns: any = null;

    async initialize(policyWasmBuffer?: Buffer) {
        if (policyWasmBuffer) {
            this.opaIns = await loadPolicy(policyWasmBuffer);
        }
    }

    async evaluate(input: any, policyContext: any): Promise<GovernanceDecision> {
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

        // --- MOCK OPA BEHAVIOR ---
        const text = (input.message || '').toLowerCase();

        // 1. DLP Semantic PII Detection
        if (policyContext?.rules?.pii_filter) {
            const dlpResult: SanitizationResult = dlpEngine.sanitize(input.message || '');

            if (dlpResult.hasPII) {
                const detectedTypes = [...new Set(dlpResult.detections.map(d => d.type))];
                return {
                    allowed: true,
                    action: 'FLAG',
                    reason: `DLP: PII detectado e mascarado (${detectedTypes.join(', ')})`,
                    sanitizedInput: dlpResult.sanitizedText,
                    dlpReport: {
                        totalDetections: dlpResult.detections.length,
                        types: detectedTypes
                    }
                };
            }
        }

        // 2. Topic blacklisting
        const forbiddenTopics = policyContext?.rules?.forbidden_topics || [];
        for (const topic of forbiddenTopics) {
            if (text.includes(topic.toLowerCase())) {
                return { allowed: false, reason: `Bloqueado pela Política (OPA): Assunto proibido detectado (${topic})`, action: 'BLOCK' }
            }
        }

        // 3. Jailbreak / Prompt Injection Prevention
        const bypassPhrases = ["ignore previous", "admin mode", "bypass"];
        if (bypassPhrases.some(p => text.includes(p))) {
            return { allowed: false, reason: `Bloqueado pela Política (OPA): Tentativa de Evasão de Regras`, action: 'BLOCK' }
        }

        // 4. HIGH-RISK ACTION DETECTION → Human-in-the-Loop
        // M3 FIX: Keywords are now configurable via policyContext; falls back to built-in defaults
        if (policyContext?.rules?.hitl_enabled !== false) {
            const keywords: string[] = policyContext?.rules?.hitl_keywords || HIGH_RISK_KEYWORDS;
            const matchedKeyword = keywords.find(kw => text.includes(kw.toLowerCase()));
            if (matchedKeyword) {
                return {
                    allowed: false,
                    action: 'PENDING_APPROVAL',
                    reason: `Ação de alto risco detectada: "${matchedKeyword}" — requer aprovação humana`
                };
            }
        }

        return { allowed: true, action: 'ALLOW' };
    }
}

export const opaEngine = new OpaGovernanceEngine();
