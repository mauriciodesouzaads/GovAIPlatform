export interface RiskQuestion {
    id: string;
    category: 'data_protection' | 'human_oversight' | 'transparency' | 'security' | 'fairness';
    question: string;
    description: string;
    type: 'yes_no' | 'scale' | 'select';
    options?: string[];
    weight: number;
    scoring: Record<string, number>;
    prefill_field?: string;
}

export const CATEGORY_LABELS: Record<string, string> = {
    data_protection: 'Proteção de Dados',
    human_oversight: 'Supervisão Humana',
    transparency: 'Transparência',
    security: 'Segurança',
    fairness: 'Equidade',
};

export const RISK_QUESTIONS: RiskQuestion[] = [
    // ── DATA PROTECTION (5 perguntas) ──
    {
        id: 'dp_1', category: 'data_protection',
        question: 'O assistente processa dados pessoais?',
        description: 'Dados que identificam direta ou indiretamente uma pessoa natural (CPF, nome, email, telefone)',
        type: 'yes_no', weight: 5, scoring: { yes: 0, no: 100 }, prefill_field: 'data_classification',
    },
    {
        id: 'dp_2', category: 'data_protection',
        question: 'Qual a classificação dos dados processados?',
        description: 'Interno (dados públicos), Confidencial (dados de negócio), Restrito (dados pessoais sensíveis)',
        type: 'select', options: ['internal', 'confidential', 'restricted'], weight: 5,
        scoring: { internal: 100, confidential: 50, restricted: 0 },
    },
    {
        id: 'dp_3', category: 'data_protection',
        question: 'O DLP (mascaramento de dados) está ativo?',
        description: 'O filtro de PII mascara automaticamente CPF, email, telefone antes de enviar ao modelo',
        type: 'yes_no', weight: 4, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'dp_4', category: 'data_protection',
        question: 'Os dados são enviados para servidores fora do Brasil?',
        description: 'Se o provider LLM está em outro país, dados cruzam fronteira',
        type: 'yes_no', weight: 3, scoring: { yes: 0, no: 100 },
    },
    {
        id: 'dp_5', category: 'data_protection',
        question: 'Existe política de retenção configurada?',
        description: 'Logs de execução são arquivados/removidos após período definido',
        type: 'yes_no', weight: 2, scoring: { yes: 100, no: 0 },
    },

    // ── HUMAN OVERSIGHT (5 perguntas) ──
    {
        id: 'ho_1', category: 'human_oversight',
        question: 'O HITL (aprovação humana) está ativo?',
        description: 'Execuções com keywords sensíveis pausam para aprovação',
        type: 'yes_no', weight: 5, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'ho_2', category: 'human_oversight',
        question: 'Existe processo formal de aprovação de assistentes?',
        description: 'Lifecycle completo com revisão multi-trilha antes de publicar',
        type: 'yes_no', weight: 5, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'ho_3', category: 'human_oversight',
        question: 'O assistente toma decisões autônomas?',
        description: 'Ações executadas sem confirmação humana (ex: enviar email, atualizar registro)',
        type: 'yes_no', weight: 4, scoring: { yes: 0, no: 100 },
    },
    {
        id: 'ho_4', category: 'human_oversight',
        question: 'Qual o impacto de uma resposta incorreta?',
        description: 'Baixo (informativo), Médio (decisão de negócio), Alto (impacto financeiro/legal)',
        type: 'select', options: ['low', 'medium', 'high'], weight: 5,
        scoring: { low: 100, medium: 50, high: 0 },
    },
    {
        id: 'ho_5', category: 'human_oversight',
        question: 'Existe mecanismo de feedback do usuário?',
        description: 'O usuário final pode reportar respostas incorretas ou inadequadas',
        type: 'yes_no', weight: 2, scoring: { yes: 100, no: 0 },
    },

    // ── TRANSPARENCY (5 perguntas) ──
    {
        id: 'tr_1', category: 'transparency',
        question: 'O usuário sabe que está interagindo com IA?',
        description: 'Banner visível informando que a sessão é assistida por IA',
        type: 'yes_no', weight: 5, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'tr_2', category: 'transparency',
        question: 'O audit trail é completo e imutável?',
        description: 'Todas as execuções são registradas com HMAC-SHA256',
        type: 'yes_no', weight: 5, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'tr_3', category: 'transparency',
        question: 'Existe documentação técnica do assistente?',
        description: 'Ficha técnica (Model Card) preenchida com limitações e vieses',
        type: 'yes_no', weight: 3, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'tr_4', category: 'transparency',
        question: 'O changelog de versões é mantido?',
        description: 'Cada mudança no prompt é versionada com descrição',
        type: 'yes_no', weight: 3, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'tr_5', category: 'transparency',
        question: 'Relatórios de compliance são gerados periodicamente?',
        description: 'Relatório consolidado com hash SHA-256 para auditores',
        type: 'yes_no', weight: 2, scoring: { yes: 100, no: 0 },
    },

    // ── SECURITY (5 perguntas) ──
    {
        id: 'se_1', category: 'security',
        question: 'O assistente tem acesso a ferramentas externas (MCP)?',
        description: 'Tool calls que acessam bancos de dados, APIs, sistemas externos',
        type: 'yes_no', weight: 4, scoring: { yes: 0, no: 100 },
    },
    {
        id: 'se_2', category: 'security',
        question: 'A detecção de jailbreak está ativa?',
        description: 'OPA Engine detecta tentativas de bypass de segurança',
        type: 'yes_no', weight: 5, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'se_3', category: 'security',
        question: 'Existe monitoramento de Shadow AI?',
        description: 'Shield detecta uso de IA não autorizada na organização',
        type: 'yes_no', weight: 3, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'se_4', category: 'security',
        question: 'A criptografia de payloads está ativa?',
        description: 'Execuções armazenadas com AES-256-GCM',
        type: 'yes_no', weight: 3, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'se_5', category: 'security',
        question: 'Existe controle de quota (FinOps)?',
        description: 'Hard cap de tokens/custo por organização',
        type: 'yes_no', weight: 2, scoring: { yes: 100, no: 0 },
    },

    // ── FAIRNESS (5 perguntas) ──
    {
        id: 'fa_1', category: 'fairness',
        question: 'O assistente pode gerar conteúdo discriminatório?',
        description: 'Risco de viés por gênero, raça, idade, região',
        type: 'select', options: ['low', 'medium', 'high'], weight: 5,
        scoring: { low: 100, medium: 50, high: 0 },
    },
    {
        id: 'fa_2', category: 'fairness',
        question: 'Existem tópicos proibidos configurados?',
        description: 'Lista de temas bloqueados no motor de políticas',
        type: 'yes_no', weight: 3, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'fa_3', category: 'fairness',
        question: 'O assistente é usado para decisões que afetam direitos?',
        description: 'Crédito, emprego, benefícios, processos judiciais',
        type: 'yes_no', weight: 5, scoring: { yes: 0, no: 100 },
    },
    {
        id: 'fa_4', category: 'fairness',
        question: 'Existe validação periódica dos outputs?',
        description: 'Revisão humana de amostra de respostas para detectar vieses',
        type: 'yes_no', weight: 3, scoring: { yes: 100, no: 0 },
    },
    {
        id: 'fa_5', category: 'fairness',
        question: 'O modelo foi avaliado para vieses em português brasileiro?',
        description: 'Testes específicos para contexto cultural e linguístico do Brasil',
        type: 'yes_no', weight: 2, scoring: { yes: 100, no: 0 },
    },
];

export function computeRiskScore(answers: Record<string, any>): {
    totalScore: number;
    riskLevel: string;
    categoryScores: Record<string, number>;
    recommendations: string[];
} {
    const categoryTotals: Record<string, { sum: number; weight: number }> = {};
    const recommendations: string[] = [];

    for (const q of RISK_QUESTIONS) {
        const answer = answers[q.id];
        if (answer === undefined || answer === null) continue;

        const answerStr = String(answer);
        const score = q.scoring[answerStr] ?? 0;

        if (!categoryTotals[q.category]) categoryTotals[q.category] = { sum: 0, weight: 0 };
        categoryTotals[q.category].sum += score * q.weight;
        categoryTotals[q.category].weight += q.weight;

        if (score < 50 && q.weight >= 3) {
            recommendations.push(`${CATEGORY_LABELS[q.category]}: ${q.question} — ação recomendada`);
        }
    }

    const categoryScores: Record<string, number> = {};
    let globalSum = 0;
    let globalWeight = 0;

    for (const [cat, totals] of Object.entries(categoryTotals)) {
        categoryScores[cat] = totals.weight > 0 ? Math.round((totals.sum / totals.weight) * 100) / 100 : 0;
        globalSum += totals.sum;
        globalWeight += totals.weight;
    }

    const totalScore = globalWeight > 0 ? Math.round((globalSum / globalWeight) * 100) / 100 : 0;
    const riskLevel = totalScore >= 75 ? 'low' : totalScore >= 50 ? 'medium' : totalScore >= 25 ? 'high' : 'critical';

    return { totalScore: Math.round(totalScore), riskLevel, categoryScores, recommendations };
}
