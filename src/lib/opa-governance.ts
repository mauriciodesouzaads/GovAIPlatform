import { loadPolicy } from '@open-policy-agent/opa-wasm';
import { dlpEngine, SanitizationResult } from './dlp-engine';
import { Pool } from 'pg';

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

/** Default high-risk keywords (fallback when org has no custom keywords in DB) */
const DEFAULT_HITL_KEYWORDS = [
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
    private pool: Pool | null = null;

    async initialize(policyWasmBuffer?: Buffer, pgPool?: Pool) {
        if (policyWasmBuffer) {
            this.opaIns = await loadPolicy(policyWasmBuffer);
        }
        if (pgPool) {
            this.pool = pgPool;
        }
    }

    /**
     * Load HITL keywords from org_hitl_keywords table.
     * Falls back to DEFAULT_HITL_KEYWORDS if no custom keywords exist for the org.
     */
    private async loadOrgKeywords(orgId: string): Promise<string[]> {
        if (!this.pool) return DEFAULT_HITL_KEYWORDS;

        try {
            const result = await this.pool.query(
                'SELECT keyword FROM org_hitl_keywords WHERE org_id = $1',
                [orgId]
            );
            if (result.rows.length > 0) {
                return result.rows.map((r: any) => r.keyword.toLowerCase());
            }
        } catch {
            // DB error — fall back to defaults silently
        }
        return DEFAULT_HITL_KEYWORDS;
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

        // 1. DLP Semantic PII Detection (Executes natively outside OPA)
        if (policyContext?.rules?.pii_filter) {
            const dlpResult: SanitizationResult = await dlpEngine.sanitizeSemanticNLP(input.message || '');

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
        // Keywords loaded from org_hitl_keywords table (per-tenant) or defaults
        if (policyContext?.rules?.hitl_enabled !== false) {
            const orgId = policyContext?.orgId || input.orgId;
            const keywords = policyContext?.rules?.hitl_keywords
                || (orgId ? await this.loadOrgKeywords(orgId) : DEFAULT_HITL_KEYWORDS);
            const matchedKeyword = keywords.find((kw: string) => text.includes(kw.toLowerCase()));
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
