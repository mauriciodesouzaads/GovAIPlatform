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
        const text = (input.message || '').toLowerCase();

        // STAGE 1: DLP — SEMPRE executa, independente do modo OPA
        if (policyContext?.rules?.pii_filter !== false) {
            const dlpResult: SanitizationResult = await dlpEngine.sanitizeSemanticNLP(input.message || '');
            if (dlpResult.hasPII) {
                const detectedTypes = [...new Set(dlpResult.detections.map(d => d.type))];
                return {
                    allowed: true,
                    action: 'FLAG',
                    reason: `DLP: PII detectado e mascarado (${detectedTypes.join(', ')})`,
                    sanitizedInput: dlpResult.sanitizedText,
                    dlpReport: { totalDetections: dlpResult.detections.length, types: detectedTypes }
                };
            }
        }

        // STAGE 2: HITL keywords — SEMPRE executa, independente do modo OPA
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

        // STAGE 3 + 4: Blacklist e Injection — usa OPA WASM se disponível, fallback para regras nativas
        if (this.opaIns != null) {
            try {
                const payload = {
                    input: {
                        message: input.message,
                        rules: policyContext?.rules || {}
                    }
                };
                console.log("[OPA WASM DEBUG] Payload sent to evaluate:", JSON.stringify(payload));
                const resultSet = this.opaIns.evaluate(payload);
                console.log("[OPA WASM DEBUG] ResultSet from WASM:", JSON.stringify(resultSet));

                const result = resultSet[0]?.result;
                if (result && result.allow === false) {
                    return {
                        allowed: false,
                        reason: result.reason || 'Bloqueado por Política OPA Corporativa',
                        action: 'BLOCK'
                    };
                }
            } catch (opaErr) {
                // OPA falhou — fallback para regras nativas abaixo
            }
            return { allowed: true, action: 'ALLOW' };
        }

        // Fallback nativo (quando WASM não disponível)
        const forbiddenTopics = policyContext?.rules?.forbidden_topics || [];
        for (const topic of forbiddenTopics) {
            if (text.includes(topic.toLowerCase())) {
                return { allowed: false, reason: `Bloqueado pela Política: Assunto proibido (${topic})`, action: 'BLOCK' };
            }
        }
        const bypassPhrases = ['ignore previous', 'admin mode', 'bypass'];
        if (bypassPhrases.some(p => text.includes(p))) {
            return { allowed: false, reason: 'Bloqueado pela Política: Tentativa de Evasão de Regras', action: 'BLOCK' };
        }

        return { allowed: true, action: 'ALLOW' };
    }
}

export const opaEngine = new OpaGovernanceEngine();
