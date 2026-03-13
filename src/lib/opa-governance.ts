import { loadPolicy } from '@open-policy-agent/opa-wasm';
import { dlpEngine, SanitizationResult } from './dlp-engine';
import { Pool } from 'pg';

export interface GovernanceDecision {
    allowed: boolean;
    reason?: string;
    action?: 'BLOCK' | 'FLAG' | 'ALLOW' | 'PENDING_APPROVAL';
    /** OWASP LLM Top 10 category when a violation is detected */
    category?: string;
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

// ── OWASP LLM01: Prompt Injection ─────────────────────────────────────────────
// Mirror exact of govai.rego llm01_* phrase arrays.
// Any modification here MUST be reflected in govai.rego and vice-versa.

const LLM01_BYPASS_PHRASES: string[] = [
    // Classic override
    'ignore previous', 'ignore all previous',
    'disregard previous', 'disregard all instructions', 'disregard the above',
    'forget instructions', 'forget your instructions', 'forget everything',
    'forget all previous', 'override instructions', 'override your instructions',
    'bypass restrictions', 'bypass security', 'bypass filter',
    'skip restrictions', 'skip instructions',
    // Privilege escalation modes
    'admin mode', 'developer mode', 'god mode', 'root mode',
    'jailbreak', 'do anything now', 'dan mode', 'dude mode',
    'no restrictions', 'without restrictions', 'remove restrictions',
    'ignore safety', 'disable safety', 'turn off restrictions',
    // Instruction hijacking
    'new instructions:', 'updated instructions:', 'revised instructions:',
    'your actual instructions', 'your true instructions', 'your real instructions',
    'ignore the system prompt', 'ignore system instructions',
];

const LLM01_ROLEPLAY_PHRASES: string[] = [
    // Persona hijacking
    'pretend you are', "pretend you're", 'pretend to be',
    'act as if you are', 'act as a', 'act as an',
    'roleplay as', 'role-play as', 'role play as',
    'you are now', 'from now on you are', 'from now on you will',
    'simulate being', 'simulate a', 'simulate an',
    'imagine you are', 'imagine you have no', 'imagine you have been',
    'behave as', 'behave like', 'respond as',
    'your new persona', 'take on the persona', 'assume the persona',
    'you have been reprogrammed', 'you have been updated',
    'you are no longer', 'you are not an ai',
];

const LLM01_DELIMITER_PHRASES: string[] = [
    '### system', '## system', '# system',
    '[system]', '[system prompt]',
    'new conversation starts here', 'conversation reset',
    'ignore all context', 'reset context', 'clear context',
    'end of system prompt', 'begin new prompt',
    'user input begins', 'end of instructions',
];

// ── OWASP LLM06: Sensitive Information Disclosure ─────────────────────────────
// Mirror exact of govai.rego llm06_* phrase arrays.

const LLM06_SYSTEM_PROMPT_PHRASES: string[] = [
    'reveal your instructions',  'reveal your system prompt',
    'show me your instructions', 'show me your prompt',
    'show your system prompt',   'show your instructions',
    'what are your instructions','what are your rules',
    'what are your constraints',
    'print your prompt',         'print your instructions',
    'output your instructions',  'output your prompt',
    'display your instructions', 'display your prompt',
    'tell me your instructions', 'tell me your prompt',
    'what is your initial prompt','what is your system prompt',
    'repeat your instructions',  'repeat your prompt',
    'dump your instructions',
];

const LLM06_CREDENTIAL_PHRASES: string[] = [
    'show api key',    'reveal api key',   'print api key',
    'show api keys',   'give me api key',  'get api key',
    'give me credentials', 'show credentials', 'reveal credentials',
    'show me secrets', 'reveal secrets',   'print secrets',
    'show password',   'reveal password',  'print password',
    'show private key','reveal private key',
    'show environment variables', 'print environment variables',
    'show env vars',   'print env vars',   'echo $env',
    'show .env',       'cat .env',         'read .env',
    'show config',     'reveal config',    'print config',
];

const LLM06_SHELL_PHRASES: string[] = [
    // Filesystem traversal
    'cat /etc/', 'cat /proc/', 'cat /var/',
    '/etc/passwd', '/etc/shadow', '/etc/hosts',
    '/proc/self/', '../../etc/',
    // Destructive commands
    'rm -rf', 'rmdir /s', 'del /f',
    'drop database', 'drop table', 'drop schema',
    'delete from', 'truncate table', 'truncate database',
    // Code injection
    'exec(', 'eval(', '__import__(',
    'os.system(', 'subprocess.call(', 'subprocess.run(',
    'shell_exec(', 'system(', 'passthru(',
    // Shell meta-characters in exploit context
    '; cat ', '&& cat ', '| cat ', '; ls /', '&& ls /',
];

interface NativeViolation {
    category: string;
    phrase: string;
}

/**
 * Evaluates a message against the OWASP LLM01 + LLM06 rule sets natively.
 * Returns null if no violation is found.
 * This mirrors the logic in govai.rego exactly so results are consistent
 * whether the WASM is loaded or not.
 */
function nativeOwaspEvaluate(message: string): {
    allowed: false;
    reason: string;
    category: string;
    violation: NativeViolation;
} | null {
    const lower = message.toLowerCase();

    // LLM01 check (bypass + roleplay + delimiter)
    const allLlm01 = [...LLM01_BYPASS_PHRASES, ...LLM01_ROLEPLAY_PHRASES, ...LLM01_DELIMITER_PHRASES];
    const injectionMatch = allLlm01.find(p => lower.includes(p));

    // LLM06 check (system prompt + credentials + shell)
    const allLlm06 = [...LLM06_SYSTEM_PROMPT_PHRASES, ...LLM06_CREDENTIAL_PHRASES, ...LLM06_SHELL_PHRASES];
    const disclosureMatch = allLlm06.find(p => lower.includes(p));

    if (injectionMatch && disclosureMatch) {
        return {
            allowed: false,
            reason: 'LLM01+LLM06: Prompt Injection e extração de informações sensíveis (ataque combinado)',
            category: 'LLM01+LLM06:Combined',
            violation: { category: 'LLM01+LLM06:Combined', phrase: injectionMatch },
        };
    }
    if (injectionMatch) {
        return {
            allowed: false,
            reason: 'LLM01: Prompt Injection — tentativa de manipulação de instruções do sistema',
            category: 'LLM01:PromptInjection',
            violation: { category: 'LLM01:PromptInjection', phrase: injectionMatch },
        };
    }
    if (disclosureMatch) {
        return {
            allowed: false,
            reason: 'LLM06: Extração de informações sensíveis (system prompt, credenciais ou filesystem)',
            category: 'LLM06:SensitiveInfoDisclosure',
            violation: { category: 'LLM06:SensitiveInfoDisclosure', phrase: disclosureMatch },
        };
    }
    return null;
}

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

        // ── STAGE 1: DLP ─────────────────────────────────────────────────────
        // Always runs, independent of OPA mode.
        if (policyContext?.rules?.pii_filter !== false) {
            const dlpResult: SanitizationResult = await dlpEngine.sanitizeSemanticNLP(input.message || '');
            if (dlpResult.hasPII) {
                const detectedTypes = [...new Set(dlpResult.detections.map(d => d.type))];
                return {
                    allowed: true,
                    action: 'FLAG',
                    reason: `DLP: PII detectado e mascarado (${detectedTypes.join(', ')})`,
                    sanitizedInput: dlpResult.sanitizedText,
                    dlpReport: { totalDetections: dlpResult.detections.length, types: detectedTypes },
                };
            }
        }

        // ── STAGE 2: HITL ─────────────────────────────────────────────────────
        // Always runs, independent of OPA mode.
        if (policyContext?.rules?.hitl_enabled !== false) {
            const orgId = policyContext?.orgId || input.orgId;
            const keywords = policyContext?.rules?.hitl_keywords
                || (orgId ? await this.loadOrgKeywords(orgId) : DEFAULT_HITL_KEYWORDS);
            const matchedKeyword = keywords.find((kw: string) => text.includes(kw.toLowerCase()));
            if (matchedKeyword) {
                return {
                    allowed: false,
                    action: 'PENDING_APPROVAL',
                    reason: `Ação de alto risco detectada: "${matchedKeyword}" — requer aprovação humana`,
                };
            }
        }

        // ── STAGE 3: OPA WASM ────────────────────────────────────────────────
        // Runs if WASM is loaded. Returns immediately on violation.
        // If WASM fails or is not loaded, falls through to STAGE 4.
        if (this.opaIns != null) {
            try {
                const payload = {
                    input: {
                        message: input.message,
                        rules: policyContext?.rules || {},
                    },
                };
                const resultSet = this.opaIns.evaluate(payload);
                if (process.env.LOG_LEVEL === 'debug') {
                    console.log('[OPA WASM] ResultSet:', JSON.stringify(resultSet));
                }

                const result = resultSet[0]?.result;
                const isDisallowed = (result === false) || (result && result.allow === false);

                if (isDisallowed) {
                    return {
                        allowed: false,
                        reason: (result && result.reason) || 'Bloqueado por Política OPA Corporativa',
                        category: (result && result.category) || 'OPA:PolicyViolation',
                        action: 'BLOCK',
                    };
                }
                // WASM says allowed — still run STAGE 4 for defense-in-depth
            } catch (opaErr) {
                // WASM evaluation failed — continue to STAGE 4
                if (process.env.LOG_LEVEL === 'debug') {
                    console.warn('[OPA WASM] Evaluation failed, falling back to native rules:', opaErr);
                }
            }
        }

        // ── STAGE 4: Native OWASP Rules (Defense-in-Depth) ──────────────────
        // Runs ALWAYS (even after WASM passes) to ensure baseline coverage.
        // Implements the same rule set as govai.rego — any change to one MUST
        // be mirrored in the other.

        // 4a. Forbidden topics (org-configurable)
        const forbiddenTopics: string[] = policyContext?.rules?.forbidden_topics || [];
        for (const topic of forbiddenTopics) {
            if (text.includes(topic.toLowerCase())) {
                return {
                    allowed: false,
                    reason: `POLICY: Assunto proibido pela configuração da organização (${topic})`,
                    category: 'POLICY:ForbiddenTopic',
                    action: 'BLOCK',
                };
            }
        }

        // 4b. OWASP LLM01 + LLM06 native evaluation
        const owaspResult = nativeOwaspEvaluate(input.message || '');
        if (owaspResult) {
            return {
                allowed: false,
                reason: owaspResult.reason,
                category: owaspResult.category,
                action: 'BLOCK',
            };
        }

        return { allowed: true, action: 'ALLOW' };
    }
}

export const opaEngine = new OpaGovernanceEngine();
