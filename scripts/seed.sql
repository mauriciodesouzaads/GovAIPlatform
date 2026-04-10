-- ============================================================================
-- GovAI Platform — Rich Demo Seed (FASE-A3)
-- ============================================================================
-- Idempotent: safe to run multiple times (ON CONFLICT DO NOTHING / DO UPDATE).
-- Must run as govai_app with app.current_org_id set for RLS-gated tables.
-- Audit logs with HMAC are inserted separately by seed-audit-logs.js.
-- ============================================================================

BEGIN;

-- Set org context for ALL RLS policies in this transaction
SELECT set_config('app.current_org_id', '00000000-0000-0000-0000-000000000001', true);

-- ── 1.1 Organization ─────────────────────────────────────────────────────────

INSERT INTO organizations (id, name, hitl_timeout_hours)
VALUES ('00000000-0000-0000-0000-000000000001', 'GovAI Demo Org', 4)
ON CONFLICT (id) DO UPDATE SET
    name                = 'GovAI Demo Org',
    hitl_timeout_hours  = 4;

-- ── 1.2 Users (4 personas) ───────────────────────────────────────────────────
-- Password "GovAI2026@Admin" — bcrypt cost 12 hash same as existing admin

-- 1: admin@orga.com (existing, update name)
INSERT INTO users (id, org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES (
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    '00000000-0000-0000-0000-000000000001',
    'admin@orga.com', 'Administrador', 'local', 'admin@orga.com',
    '$2b$12$VdUXuk5WPohL.NMRBfdRm.silId9k7Z7yuAmHu1Ssydc3yHDkyRGy',
    false, 'admin'
) ON CONFLICT (id) DO UPDATE SET
    name                     = 'Administrador',
    password_hash            = EXCLUDED.password_hash,
    requires_password_change = false;

-- 2: compliance@orga.com — Maria Santos (DPO)
INSERT INTO users (id, org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES (
    '00000000-0000-0000-0001-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'compliance@orga.com', 'Maria Santos', 'local', 'compliance@orga.com',
    '$2b$12$VdUXuk5WPohL.NMRBfdRm.silId9k7Z7yuAmHu1Ssydc3yHDkyRGy',
    false, 'dpo'
) ON CONFLICT (id) DO UPDATE SET
    name                     = 'Maria Santos',
    password_hash            = EXCLUDED.password_hash,
    requires_password_change = false;

-- 3: dev@orga.com — João Silva (operator)
INSERT INTO users (id, org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES (
    '00000000-0000-0000-0001-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'dev@orga.com', 'João Silva', 'local', 'dev@orga.com',
    '$2b$12$VdUXuk5WPohL.NMRBfdRm.silId9k7Z7yuAmHu1Ssydc3yHDkyRGy',
    false, 'operator'
) ON CONFLICT (id) DO UPDATE SET
    name                     = 'João Silva',
    password_hash            = EXCLUDED.password_hash,
    requires_password_change = false;

-- 4: ciso@orga.com — Carlos Oliveira (admin)
INSERT INTO users (id, org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES (
    '00000000-0000-0000-0001-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'ciso@orga.com', 'Carlos Oliveira', 'local', 'ciso@orga.com',
    '$2b$12$VdUXuk5WPohL.NMRBfdRm.silId9k7Z7yuAmHu1Ssydc3yHDkyRGy',
    false, 'admin'
) ON CONFLICT (id) DO UPDATE SET
    name                     = 'Carlos Oliveira',
    password_hash            = EXCLUDED.password_hash,
    requires_password_change = false;

-- ── 1.3 Policy Versions (2) ──────────────────────────────────────────────────

INSERT INTO policy_versions (id, org_id, name, rules_jsonb, version)
VALUES (
    '00000000-0000-0000-0003-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Política Padrão',
    '{"forbidden_topics":["armas","drogas","conteúdo adulto"],"pii_filter":true,"strict_mode":false,"hitl_enabled":true,"hitl_keywords":["demitir","rescindir","processo judicial"],"max_tokens":4096}'::jsonb,
    1
) ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_versions (id, org_id, name, rules_jsonb, version)
VALUES (
    '00000000-0000-0000-0003-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Política Restritiva',
    '{"forbidden_topics":["armas","drogas","conteúdo adulto","dados pessoais","informações financeiras"],"pii_filter":true,"strict_mode":true,"hitl_enabled":true,"hitl_keywords":["demitir","rescindir","processo judicial","remover limite","override"],"max_tokens":2048}'::jsonb,
    1
) ON CONFLICT (id) DO NOTHING;

-- ── 1.4 Assistants (5 + update existing demo) ────────────────────────────────

-- 1: Assistente Jurídico — high risk (official)
INSERT INTO assistants (
    id, org_id, name, status, lifecycle_state, description,
    risk_level, data_classification, pii_blocker_enabled, output_format,
    risk_score, risk_breakdown, risk_computed_at,
    capability_tags, owner_id, owner_email
) VALUES (
    '00000000-0000-0000-0002-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Assistente Jurídico',
    'published', 'official',
    'Análise de contratos, cláusulas e pareceres jurídicos. Suporte a revisão de termos e condições com base na legislação brasileira vigente.',
    'high', 'confidential', true, 'free_text',
    35,
    '{"total_score":35,"level":"high","computed_at":"2026-03-01T00:00:00Z","classification":{"score":10,"explanation":"Dados confidenciais processados pelo assistente (+10)"},"connectors":{"score":15,"explanation":"Conector read_write com sistema jurídico externo (+15)"},"extra_connectors":{"score":5,"explanation":"1 conector adicional além do primeiro (+5)"},"pii_blocker":{"score":0,"explanation":"PII blocker ativo — nenhuma penalidade aplicada"},"output_format":{"score":5,"explanation":"Saída em texto livre — menos previsível (+5)"}}'::jsonb,
    NOW() - INTERVAL '37 days',
    ARRAY['Jurídico'],
    '00000000-0000-0000-0001-000000000002',
    'compliance@orga.com'
) ON CONFLICT (id) DO UPDATE SET
    lifecycle_state    = 'official',
    status             = 'published',
    risk_level         = 'high',
    data_classification = 'confidential',
    pii_blocker_enabled = true,
    output_format      = 'free_text',
    risk_score         = 35,
    capability_tags    = ARRAY['Jurídico'],
    risk_computed_at   = NOW() - INTERVAL '37 days';

-- 2: FAQ Interno RH — low risk (official)
INSERT INTO assistants (
    id, org_id, name, status, lifecycle_state, description,
    risk_level, data_classification, pii_blocker_enabled, output_format,
    risk_score, risk_breakdown, risk_computed_at,
    capability_tags, owner_id, owner_email
) VALUES (
    '00000000-0000-0000-0002-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'FAQ Interno RH',
    'published', 'official',
    'Respostas sobre políticas de RH, benefícios, férias, folha de pagamento e processos internos. Direcionado a colaboradores.',
    'low', 'internal', true, 'structured_json',
    0,
    '{"total_score":0,"level":"low","computed_at":"2026-02-15T00:00:00Z","classification":{"score":0,"explanation":"Dados classificados como internos — risco base zero"},"connectors":{"score":0,"explanation":"Sem integrações externas ativas"},"extra_connectors":{"score":0,"explanation":"Nenhum conector adicional"},"pii_blocker":{"score":0,"explanation":"PII blocker ativo — nenhuma penalidade aplicada"},"output_format":{"score":0,"explanation":"Saída estruturada JSON — totalmente auditável"}}'::jsonb,
    NOW() - INTERVAL '22 days',
    ARRAY['RH'],
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    'admin@orga.com'
) ON CONFLICT (id) DO UPDATE SET
    lifecycle_state    = 'official',
    status             = 'published',
    risk_level         = 'low',
    data_classification = 'internal',
    pii_blocker_enabled = true,
    output_format      = 'structured_json',
    risk_score         = 0,
    capability_tags    = ARRAY['RH'],
    risk_computed_at   = NOW() - INTERVAL '22 days';

-- 3: Análise de Crédito — critical risk (official)
INSERT INTO assistants (
    id, org_id, name, status, lifecycle_state, description,
    risk_level, data_classification, pii_blocker_enabled, output_format,
    risk_score, risk_breakdown, risk_computed_at,
    capability_tags, owner_id, owner_email
) VALUES (
    '00000000-0000-0000-0002-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'Análise de Crédito',
    'published', 'official',
    'Suporte à análise de risco de crédito com base em dados financeiros. Assistente de alto risco com dados restritos — requer aprovação multi-nível.',
    'critical', 'restricted', true, 'free_text',
    55,
    '{"total_score":55,"level":"critical","computed_at":"2026-03-15T00:00:00Z","classification":{"score":25,"explanation":"Dados restritos (BACEN/financeiro) — maior penalidade de classificação (+25)"},"connectors":{"score":20,"explanation":"Conector externo (sistema legado BACEN) — maior penalidade de integração (+20)"},"extra_connectors":{"score":5,"explanation":"1 conector adicional (datawarehouse financeiro) (+5)"},"pii_blocker":{"score":0,"explanation":"PII blocker ativo — nenhuma penalidade aplicada"},"output_format":{"score":5,"explanation":"Saída em texto livre — menos previsível (+5)"}}'::jsonb,
    NOW() - INTERVAL '7 days',
    ARRAY['Financeiro'],
    '00000000-0000-0000-0001-000000000004',
    'ciso@orga.com'
) ON CONFLICT (id) DO UPDATE SET
    lifecycle_state    = 'official',
    status             = 'published',
    risk_level         = 'critical',
    data_classification = 'restricted',
    pii_blocker_enabled = true,
    output_format      = 'free_text',
    risk_score         = 55,
    capability_tags    = ARRAY['Financeiro'],
    risk_computed_at   = NOW() - INTERVAL '7 days';

-- 4: Gerador de Relatórios — medium risk (approved, not yet official)
INSERT INTO assistants (
    id, org_id, name, status, lifecycle_state, description,
    risk_level, data_classification, pii_blocker_enabled, output_format,
    risk_score, risk_breakdown, risk_computed_at,
    capability_tags, owner_id, owner_email
) VALUES (
    '00000000-0000-0000-0002-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'Gerador de Relatórios',
    'draft', 'approved',
    'Gera relatórios de conformidade e auditoria em formato PDF. Aguardando publicação formal.',
    'medium', 'confidential', true, 'structured_json',
    25,
    '{"total_score":25,"level":"medium","computed_at":"2026-03-20T00:00:00Z","classification":{"score":10,"explanation":"Dados confidenciais processados pelo assistente (+10)"},"connectors":{"score":15,"explanation":"Conector read_write com repositório de relatórios (+15)"},"extra_connectors":{"score":0,"explanation":"Sem conectores adicionais"},"pii_blocker":{"score":0,"explanation":"PII blocker ativo — nenhuma penalidade aplicada"},"output_format":{"score":0,"explanation":"Saída estruturada JSON — totalmente auditável"}}'::jsonb,
    NOW() - INTERVAL '3 days',
    ARRAY['Relatórios'],
    '00000000-0000-0000-0001-000000000003',
    'dev@orga.com'
) ON CONFLICT (id) DO UPDATE SET
    lifecycle_state    = 'approved',
    status             = 'draft',
    risk_level         = 'medium',
    data_classification = 'confidential',
    pii_blocker_enabled = true,
    output_format      = 'structured_json',
    risk_score         = 25,
    capability_tags    = ARRAY['Relatórios'],
    risk_computed_at   = NOW() - INTERVAL '3 days';

-- 5: Chatbot Atendimento — low risk (under_review)
INSERT INTO assistants (
    id, org_id, name, status, lifecycle_state, description,
    risk_level, data_classification, pii_blocker_enabled, output_format,
    risk_score, risk_breakdown, risk_computed_at,
    capability_tags, owner_id, owner_email
) VALUES (
    '00000000-0000-0000-0002-000000000005',
    '00000000-0000-0000-0000-000000000001',
    'Chatbot Atendimento',
    'draft', 'under_review',
    'Atendimento ao cliente nível 1. Responde dúvidas frequentes sobre produtos e serviços. Em processo de revisão de segurança.',
    'low', 'internal', true, 'free_text',
    5,
    '{"total_score":5,"level":"low","computed_at":"2026-04-01T00:00:00Z","classification":{"score":0,"explanation":"Dados classificados como internos — risco base zero"},"connectors":{"score":0,"explanation":"Sem integrações externas ativas"},"extra_connectors":{"score":0,"explanation":"Nenhum conector adicional"},"pii_blocker":{"score":0,"explanation":"PII blocker ativo — nenhuma penalidade aplicada"},"output_format":{"score":5,"explanation":"Saída em texto livre — menos previsível (+5)"}}'::jsonb,
    NOW() - INTERVAL '1 day',
    ARRAY['Atendimento'],
    '00000000-0000-0000-0001-000000000003',
    'dev@orga.com'
) ON CONFLICT (id) DO UPDATE SET
    lifecycle_state    = 'under_review',
    status             = 'draft',
    risk_level         = 'low',
    data_classification = 'internal',
    pii_blocker_enabled = true,
    output_format      = 'free_text',
    risk_score         = 5,
    capability_tags    = ARRAY['Atendimento'],
    risk_computed_at   = NOW() - INTERVAL '1 day';

-- 6: Assistente de Testes — draft (for lifecycle flow validation)
INSERT INTO assistants (
    id, org_id, name, status, lifecycle_state, description,
    risk_level, data_classification, pii_blocker_enabled, output_format,
    risk_score, risk_breakdown, risk_computed_at,
    capability_tags, owner_id, owner_email
) VALUES (
    '00000000-0000-0000-0002-000000000006',
    '00000000-0000-0000-0000-000000000001',
    'Assistente de Testes',
    'draft', 'draft',
    'Assistente em rascunho para validação do fluxo de ciclo de vida. Ainda não submetido para revisão.',
    'low', 'internal', true, 'structured_json',
    0,
    '{"total_score":0,"level":"low","computed_at":"2026-04-08T00:00:00Z","classification":{"score":0,"explanation":"Dados internos"},"connectors":{"score":0,"explanation":"Sem integrações"},"extra_connectors":{"score":0,"explanation":""},"pii_blocker":{"score":0,"explanation":"PII blocker ativo"},"output_format":{"score":0,"explanation":"Saída estruturada JSON — totalmente auditável"}}'::jsonb,
    NOW(),
    ARRAY['Geral'],
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    'admin@orga.com'
) ON CONFLICT (id) DO UPDATE SET
    lifecycle_state    = 'draft',
    status             = 'draft',
    risk_level         = 'low',
    data_classification = 'internal',
    pii_blocker_enabled = true,
    output_format      = 'structured_json',
    risk_score         = 0,
    capability_tags    = ARRAY['Geral'],
    owner_id           = '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    owner_email        = 'admin@orga.com',
    risk_computed_at   = NOW();

-- Upsert demo assistant (INSERT ensures it exists in fresh DB; UPDATE keeps it current)
INSERT INTO assistants (
    id, org_id, name, status, lifecycle_state, description,
    risk_level, data_classification, pii_blocker_enabled, output_format,
    risk_score, risk_breakdown, risk_computed_at,
    capability_tags, owner_id, owner_email
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Assistente Demo',
    'published', 'official',
    'Assistente de demonstração da plataforma GovAI com governança completa.',
    'low', 'internal', true, 'free_text',
    5,
    '{"total_score":5,"level":"low","computed_at":"2026-01-01T00:00:00Z","classification":{"score":0,"explanation":"Dados internos"},"connectors":{"score":0,"explanation":"Sem integrações"},"extra_connectors":{"score":0,"explanation":""},"pii_blocker":{"score":0,"explanation":"PII blocker ativo"},"output_format":{"score":5,"explanation":"Saída texto livre (+5)"}}'::jsonb,
    NOW() - INTERVAL '90 days',
    ARRAY['Geral'],
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    'admin@orga.com'
) ON CONFLICT (id) DO UPDATE SET
    lifecycle_state    = 'official',
    status             = 'published',
    data_classification = 'internal',
    pii_blocker_enabled = true,
    output_format      = 'free_text',
    risk_level         = 'low',
    risk_score         = 5,
    capability_tags    = ARRAY['Geral'],
    risk_computed_at   = NOW() - INTERVAL '90 days',
    description        = COALESCE(assistants.description, 'Assistente de demonstração da plataforma GovAI com governança completa.');

-- ── 1.5 Assistant Versions (1 per assistant) ──────────────────────────────────

-- Version: Assistente Jurídico
INSERT INTO assistant_versions (id, org_id, assistant_id, policy_version_id, prompt, tools_jsonb, version, status)
VALUES (
    '00000000-0000-0000-0004-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000001',
    '00000000-0000-0000-0003-000000000002',  -- Política Restritiva
    'Você é um assistente jurídico especializado em direito empresarial brasileiro. Analise contratos, identifique cláusulas de risco, e sugira melhorias com base na legislação vigente. Nunca forneça parecer definitivo — sempre recomende consulta com advogado habilitado.',
    '[]'::jsonb,
    1, 'published'
) ON CONFLICT (id) DO NOTHING;

-- Version: FAQ Interno RH
INSERT INTO assistant_versions (id, org_id, assistant_id, policy_version_id, prompt, tools_jsonb, version, status)
VALUES (
    '00000000-0000-0000-0004-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000002',
    '00000000-0000-0000-0003-000000000001',  -- Política Padrão
    'Você é um assistente de RH interno. Responda perguntas sobre políticas de férias, benefícios, plano de saúde, vale-transporte e processos de admissão/demissão. Use linguagem acessível e profissional. Para questões sensíveis (demissão, assédio), oriente o colaborador a procurar o RH diretamente.',
    '[]'::jsonb,
    1, 'published'
) ON CONFLICT (id) DO NOTHING;

-- Version: Análise de Crédito
INSERT INTO assistant_versions (id, org_id, assistant_id, policy_version_id, prompt, tools_jsonb, version, status)
VALUES (
    '00000000-0000-0000-0004-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000003',
    '00000000-0000-0000-0003-000000000002',  -- Política Restritiva
    'Você é um assistente de análise de crédito para uso interno do departamento financeiro. Auxilie na avaliação de risco de crédito com base nos dados fornecidos. Nunca tome decisões de crédito automaticamente — apresente análise e recomendações para o analista humano. Classifique o risco como baixo, médio ou alto com justificativa.',
    '[]'::jsonb,
    1, 'published'
) ON CONFLICT (id) DO NOTHING;

-- Version: Gerador de Relatórios
INSERT INTO assistant_versions (id, org_id, assistant_id, policy_version_id, prompt, tools_jsonb, version, status)
VALUES (
    '00000000-0000-0000-0004-000000000004',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000004',
    '00000000-0000-0000-0003-000000000001',  -- Política Padrão
    'Você gera relatórios de conformidade e auditoria. Formate os dados de entrada em seções claras: sumário executivo, métricas principais, detalhamento por assistente, e recomendações. Output em formato estruturado para processamento posterior.',
    '[]'::jsonb,
    1, 'draft'
) ON CONFLICT (id) DO NOTHING;

-- Version: Chatbot Atendimento
INSERT INTO assistant_versions (id, org_id, assistant_id, policy_version_id, prompt, tools_jsonb, version, status)
VALUES (
    '00000000-0000-0000-0004-000000000005',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000005',
    '00000000-0000-0000-0003-000000000001',  -- Política Padrão
    'Você é um assistente de atendimento ao cliente nível 1. Responda dúvidas frequentes sobre produtos e serviços de forma educada e objetiva. Para solicitações que requerem ação humana (cancelamento, reembolso, reclamação formal), encaminhe para o canal apropriado com protocolo de atendimento.',
    '[]'::jsonb,
    1, 'draft'
) ON CONFLICT (id) DO NOTHING;

-- ── 1.6 Publication Events (3 — for the 3 official assistants) ───────────────

-- Jurídico published 72 days ago (first assistant published)
INSERT INTO assistant_publication_events (id, assistant_id, version_id, published_by, published_at, org_id, notes)
VALUES (
    '00000000-0000-0000-0008-000000000001',
    '00000000-0000-0000-0002-000000000001',
    '00000000-0000-0000-0004-000000000001',
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    NOW() - INTERVAL '72 days',
    '00000000-0000-0000-0000-000000000001',
    'Publicação inicial após aprovação do comitê jurídico e revisão DPO.'
) ON CONFLICT (id) DO UPDATE SET published_at = NOW() - INTERVAL '72 days';

-- FAQ RH published 68 days ago
INSERT INTO assistant_publication_events (id, assistant_id, version_id, published_by, published_at, org_id, notes)
VALUES (
    '00000000-0000-0000-0008-000000000002',
    '00000000-0000-0000-0002-000000000002',
    '00000000-0000-0000-0004-000000000002',
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    NOW() - INTERVAL '68 days',
    '00000000-0000-0000-0000-000000000001',
    'Publicação aprovada pelo RH e DPO. Escopo limitado a dados internos.'
) ON CONFLICT (id) DO UPDATE SET published_at = NOW() - INTERVAL '68 days';

-- Análise de Crédito published 60 days ago (high-risk, required longer review)
INSERT INTO assistant_publication_events (id, assistant_id, version_id, published_by, published_at, org_id, notes)
VALUES (
    '00000000-0000-0000-0008-000000000003',
    '00000000-0000-0000-0002-000000000003',
    '00000000-0000-0000-0004-000000000003',
    '00000000-0000-0000-0001-000000000004',
    NOW() - INTERVAL '60 days',
    '00000000-0000-0000-0000-000000000001',
    'Publicação após homologação pelo CISO e diretoria financeira. Uso restrito a analistas autorizados.'
) ON CONFLICT (id) DO UPDATE SET published_at = NOW() - INTERVAL '60 days';

-- ── 1.7 Shield Tools (8) ─────────────────────────────────────────────────────

INSERT INTO shield_tools (id, org_id, tool_name, tool_name_normalized, vendor, category, risk_level, approval_status)
VALUES
    ('00000000-0000-0000-0005-000000000001', '00000000-0000-0000-0000-000000000001', 'ChatGPT',               'chatgpt',          'OpenAI',       'llm_chat',   'high',     'restricted'),
    ('00000000-0000-0000-0005-000000000002', '00000000-0000-0000-0000-000000000001', 'Claude.ai',             'claude',           'Anthropic',    'llm_chat',   'medium',   'restricted'),
    ('00000000-0000-0000-0005-000000000003', '00000000-0000-0000-0000-000000000001', 'Google Gemini',         'gemini',           'Google',       'llm_chat',   'low',      'approved'),
    ('00000000-0000-0000-0005-000000000004', '00000000-0000-0000-0000-000000000001', 'Perplexity',            'perplexity',       'Perplexity AI','search_ai',  'medium',   'unknown'),
    ('00000000-0000-0000-0005-000000000005', '00000000-0000-0000-0000-000000000001', 'Copilot (Personal)',    'copilot_personal', 'Microsoft',    'llm_code',   'high',     'blocked'),
    ('00000000-0000-0000-0005-000000000006', '00000000-0000-0000-0000-000000000001', 'Midjourney',            'midjourney',       'Midjourney',   'image_gen',  'low',      'approved'),
    ('00000000-0000-0000-0005-000000000007', '00000000-0000-0000-0000-000000000001', 'GPT Personalizado (RH)','custom_gpt_rh',    'OpenAI',       'custom_gpt', 'critical', 'blocked'),
    ('00000000-0000-0000-0005-000000000008', '00000000-0000-0000-0000-000000000001', 'DeepSeek',              'deepseek',         'DeepSeek',     'llm_chat',   'medium',   'restricted')
ON CONFLICT (org_id, tool_name_normalized) DO UPDATE SET
    tool_name      = EXCLUDED.tool_name,
    vendor         = EXCLUDED.vendor,
    category       = EXCLUDED.category,
    risk_level     = EXCLUDED.risk_level,
    approval_status = EXCLUDED.approval_status;

-- ── 1.8 Shield Findings (8) ──────────────────────────────────────────────────

-- Finding 1: ChatGPT — high, open
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users)
VALUES (
    '00000000-0000-0000-0006-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'ChatGPT', 'chatgpt',
    '00000000-0000-0000-0005-000000000001',
    'high', 'open',
    '15 colaboradores utilizaram ChatGPT com contas pessoais para processar documentos internos nos últimos 30 dias. Detectado via análise de OAuth grants no Microsoft 365.',
    NOW() - INTERVAL '45 days', NOW() - INTERVAL '1 day',
    847, 15
) ON CONFLICT (id) DO NOTHING;

-- Finding 2: Claude.ai — medium, open
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users)
VALUES (
    '00000000-0000-0000-0006-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Claude.ai', 'claude',
    '00000000-0000-0000-0005-000000000002',
    'medium', 'open',
    '8 colaboradores do departamento jurídico acessaram Claude.ai. Análise de DNS indica volume significativo de tráfego fora do horário comercial.',
    NOW() - INTERVAL '30 days', NOW() - INTERVAL '2 days',
    312, 8
) ON CONFLICT (id) DO NOTHING;

-- Finding 3: Gemini — low, acknowledged
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users, acknowledged_at, acknowledged_by)
VALUES (
    '00000000-0000-0000-0006-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'Google Gemini', 'gemini',
    '00000000-0000-0000-0005-000000000003',
    'low', 'acknowledged',
    '3 usuários do time de marketing utilizaram Gemini para geração de conteúdo. Uso com dados públicos — risco baixo.',
    NOW() - INTERVAL '25 days', NOW() - INTERVAL '12 days',
    45, 3,
    NOW() - INTERVAL '10 days',
    '00000000-0000-0000-0001-000000000004'
) ON CONFLICT (id) DO NOTHING;

-- Finding 4: Perplexity — medium, open
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users)
VALUES (
    '00000000-0000-0000-0006-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'Perplexity', 'perplexity',
    '00000000-0000-0000-0005-000000000004',
    'medium', 'open',
    '5 analistas de mercado utilizam Perplexity como ferramenta de pesquisa. Potencial vazamento de queries confidenciais sobre estratégia competitiva.',
    NOW() - INTERVAL '20 days', NOW() - INTERVAL '3 days',
    156, 5
) ON CONFLICT (id) DO NOTHING;

-- Finding 5: Copilot Personal — high, open
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users)
VALUES (
    '00000000-0000-0000-0006-000000000005',
    '00000000-0000-0000-0000-000000000001',
    'Copilot (Personal)', 'copilot_personal',
    '00000000-0000-0000-0005-000000000005',
    'high', 'open',
    '12 desenvolvedores utilizam GitHub Copilot com contas pessoais (não corporativas). Código-fonte proprietário pode estar sendo enviado para treinamento de modelo externo.',
    NOW() - INTERVAL '60 days', NOW(),
    2340, 12
) ON CONFLICT (id) DO NOTHING;

-- Finding 6: Midjourney — low, resolved
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users, resolved_at, resolved_by)
VALUES (
    '00000000-0000-0000-0006-000000000006',
    '00000000-0000-0000-0000-000000000001',
    'Midjourney', 'midjourney',
    '00000000-0000-0000-0005-000000000006',
    'low', 'resolved',
    '2 designers utilizaram Midjourney para prototipagem visual. Resolvido: equipe migrou para ferramenta aprovada.',
    NOW() - INTERVAL '20 days', NOW() - INTERVAL '8 days',
    23, 2,
    NOW() - INTERVAL '5 days',
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab'
) ON CONFLICT (id) DO NOTHING;

-- Finding 7: GPT RH — critical, open
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users)
VALUES (
    '00000000-0000-0000-0006-000000000007',
    '00000000-0000-0000-0000-000000000001',
    'GPT Personalizado (RH)', 'custom_gpt_rh',
    '00000000-0000-0000-0005-000000000007',
    'critical', 'open',
    'GPT personalizado no ChatGPT detectado com acesso a dados de avaliação de desempenho de funcionários. 1 gerente de RH configurou Custom GPT com upload de planilhas contendo CPF, salário e avaliações.',
    NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
    89, 1
) ON CONFLICT (id) DO NOTHING;

-- Finding 8: DeepSeek — medium, open
INSERT INTO shield_findings (id, org_id, tool_name, tool_name_normalized, tool_id, severity, status, rationale, first_seen_at, last_seen_at, observation_count, unique_users)
VALUES (
    '00000000-0000-0000-0006-000000000008',
    '00000000-0000-0000-0000-000000000001',
    'DeepSeek', 'deepseek',
    '00000000-0000-0000-0005-000000000008',
    'medium', 'open',
    '4 engenheiros de dados utilizam DeepSeek para queries SQL e análise de dados. Servidores localizados na China — risco geopolítico para dados regulados por BACEN.',
    NOW() - INTERVAL '15 days', NOW() - INTERVAL '2 days',
    198, 4
) ON CONFLICT (id) DO NOTHING;

-- ── 1.9 Shield Posture Snapshots (3 — 90-day TechBank narrative) ─────────────

-- Snapshot 1: 85 days ago (baseline — critical posture, no governance)
INSERT INTO shield_posture_snapshots (id, org_id, generated_at, posture, summary_score, open_findings, unresolved_critical, promoted_findings, accepted_risk, top_tools, recommendations)
VALUES (
    '00000000-0000-0000-0007-000000000001',
    '00000000-0000-0000-0000-000000000001',
    NOW() - INTERVAL '85 days',
    '{"status":"critical","trend":"initial_assessment"}'::jsonb,
    25, 10, 5, 0, 0,
    '[{"name":"ChatGPT","users":20},{"name":"Copilot (Personal)","users":15}]'::jsonb,
    '["Implementar política formal de uso de IA","Bloquear Copilot Personal na rede corporativa","Realizar inventário de ferramentas AI em uso"]'::jsonb
) ON CONFLICT (id) DO UPDATE SET
    generated_at        = NOW() - INTERVAL '85 days',
    posture             = '{"status":"critical","trend":"initial_assessment"}'::jsonb,
    summary_score       = 25,
    open_findings       = 10,
    unresolved_critical = 5,
    promoted_findings   = 0,
    accepted_risk       = 0;

-- Snapshot 2: 50 days ago (improving — governance deployed, some findings resolved)
INSERT INTO shield_posture_snapshots (id, org_id, generated_at, posture, summary_score, open_findings, unresolved_critical, promoted_findings, accepted_risk, top_tools, recommendations)
VALUES (
    '00000000-0000-0000-0007-000000000002',
    '00000000-0000-0000-0000-000000000001',
    NOW() - INTERVAL '50 days',
    '{"status":"medium","trend":"improving"}'::jsonb,
    55, 8, 4, 1, 1,
    '[{"name":"ChatGPT","users":15},{"name":"Copilot (Personal)","users":12}]'::jsonb,
    '["Migrar Copilot para licença corporativa","Revisar uso do Claude.ai pelo departamento jurídico","Documentar exceções de uso aprovadas"]'::jsonb
) ON CONFLICT (id) DO UPDATE SET
    generated_at        = NOW() - INTERVAL '50 days',
    posture             = '{"status":"medium","trend":"improving"}'::jsonb,
    summary_score       = 55,
    open_findings       = 8,
    unresolved_critical = 4,
    promoted_findings   = 1,
    accepted_risk       = 1;

-- Snapshot 3: 5 days ago (latest — steady improvement, 3 critical still open)
INSERT INTO shield_posture_snapshots (id, org_id, generated_at, posture, summary_score, open_findings, unresolved_critical, promoted_findings, accepted_risk, top_tools, recommendations)
VALUES (
    '00000000-0000-0000-0007-000000000003',
    '00000000-0000-0000-0000-000000000001',
    NOW() - INTERVAL '5 days',
    '{"status":"medium","trend":"improving"}'::jsonb,
    68, 6, 3, 1, 2,
    '[{"name":"ChatGPT","users":15},{"name":"Copilot (Personal)","users":12},{"name":"GPT Personalizado (RH)","users":1}]'::jsonb,
    '["Investigar GPT personalizado de RH — risco crítico de vazamento de dados pessoais","Definir política formal para DeepSeek (risco geopolítico BACEN)","Concluir migração Copilot para versão corporativa"]'::jsonb
) ON CONFLICT (id) DO UPDATE SET
    generated_at        = NOW() - INTERVAL '5 days',
    posture             = '{"status":"medium","trend":"improving"}'::jsonb,
    summary_score       = 68,
    open_findings       = 6,
    unresolved_critical = 3,
    promoted_findings   = 1,
    accepted_risk       = 2;

-- ── 1.10 HITL Keywords ───────────────────────────────────────────────────────

INSERT INTO org_hitl_keywords (id, org_id, keyword, category)
VALUES
    ('00000000-0000-0000-000C-000000000001', '00000000-0000-0000-0000-000000000001', 'demitir',            'high_risk'),
    ('00000000-0000-0000-000C-000000000002', '00000000-0000-0000-0000-000000000001', 'rescindir',          'high_risk'),
    ('00000000-0000-0000-000C-000000000003', '00000000-0000-0000-0000-000000000001', 'processo judicial',  'high_risk'),
    ('00000000-0000-0000-000C-000000000004', '00000000-0000-0000-0000-000000000001', 'remover limite',     'high_risk'),
    ('00000000-0000-0000-000C-000000000005', '00000000-0000-0000-0000-000000000001', 'dados pessoais',     'compliance'),
    ('00000000-0000-0000-000C-000000000006', '00000000-0000-0000-0000-000000000001', 'cláusula penal',     'legal')
ON CONFLICT (org_id, keyword) DO NOTHING;

-- ── 1.11 Pending Approvals (2) ───────────────────────────────────────────────

-- HITL #1: Análise de Crédito — "remover limite"
INSERT INTO pending_approvals (id, org_id, assistant_id, message, policy_reason, trace_id, status, created_at, expires_at)
VALUES (
    '00000000-0000-0000-000B-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000003',
    'Remover limite de crédito para cliente XPTO',
    'HITL triggered: keyword "remover limite" detected in user input',
    'trace-hitl-demo-001',
    'pending',
    NOW() - INTERVAL '36 hours',
    NOW() + INTERVAL '12 hours'
) ON CONFLICT (id) DO UPDATE SET
    status     = 'pending',
    created_at = NOW() - INTERVAL '36 hours',
    expires_at = NOW() + INTERVAL '12 hours';

-- HITL #2: Assistente Jurídico — "cláusula penal"
INSERT INTO pending_approvals (id, org_id, assistant_id, message, policy_reason, trace_id, status, created_at, expires_at)
VALUES (
    '00000000-0000-0000-000B-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000001',
    'Analisar cláusula penal do contrato de prestação de serviços',
    'HITL triggered: keyword "cláusula penal" detected in user input',
    'trace-hitl-demo-002',
    'pending',
    NOW() - INTERVAL '12 hours',
    NOW() + INTERVAL '36 hours'
) ON CONFLICT (id) DO UPDATE SET
    status     = 'pending',
    created_at = NOW() - INTERVAL '12 hours',
    expires_at = NOW() + INTERVAL '36 hours';

-- ── 1.12 Policy Exceptions (2) ───────────────────────────────────────────────

-- Exception 1: Análise de Crédito — extend_token_limit (expires in 12 days)
INSERT INTO policy_exceptions (id, org_id, assistant_id, exception_type, justification, approved_by, approved_at, expires_at, status, created_by)
VALUES (
    '00000000-0000-0000-0009-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000003',
    'extend_token_limit',
    'Análises de crédito complexas requerem contexto maior que o limite padrão de 4096 tokens. Aprovado pelo CISO para o período de safra de crédito Q1 2026.',
    '00000000-0000-0000-0001-000000000004',
    NOW() - INTERVAL '15 days',
    NOW() + INTERVAL '12 days',
    'approved',
    '00000000-0000-0000-0001-000000000004'
) ON CONFLICT (id) DO UPDATE SET
    expires_at   = NOW() + INTERVAL '12 days',
    approved_at  = NOW() - INTERVAL '15 days',
    status       = 'approved';

-- Exception 2: Assistente Jurídico — allow_sensitive_topic (expires in 48 days)
INSERT INTO policy_exceptions (id, org_id, assistant_id, exception_type, justification, approved_by, approved_at, expires_at, status, created_by)
VALUES (
    '00000000-0000-0000-0009-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000001',
    'allow_sensitive_topic',
    'O assistente jurídico precisa processar temas relacionados a "processo judicial" que normalmente acionam HITL. Exceção aprovada para o time jurídico após revisão de compliance.',
    '00000000-0000-0000-0001-000000000002',
    NOW() - INTERVAL '30 days',
    NOW() + INTERVAL '48 days',
    'approved',
    '00000000-0000-0000-0001-000000000002'
) ON CONFLICT (id) DO UPDATE SET
    expires_at   = NOW() + INTERVAL '48 days',
    approved_at  = NOW() - INTERVAL '30 days',
    status       = 'approved';

-- Exception 3: Chatbot Atendimento — bypass_hitl (pending)
INSERT INTO policy_exceptions (id, org_id, assistant_id, exception_type, justification, expires_at, status, created_by)
VALUES (
    '00000000-0000-0000-0009-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0002-000000000005',
    'bypass_hitl',
    'FAQ não contém dados sensíveis, HITL causa atrito desnecessário no atendimento ao cliente nível 1. Solicitado pelo time de produto após análise de risco.',
    NOW() + INTERVAL '30 days',
    'pending',
    '00000000-0000-0000-0001-000000000003'
) ON CONFLICT (id) DO UPDATE SET
    status     = 'pending',
    expires_at = NOW() + INTERVAL '30 days';

-- ── 1.13 Demand Cases for Architect (3) ──────────────────────────────────────

-- Case 1: Migração para LLM Nacional
INSERT INTO demand_cases (id, org_id, title, description, source_type, status, priority, requested_by)
VALUES (
    '00000000-0000-0000-000A-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Migração para LLM Nacional',
    'Avaliar viabilidade de substituir Groq/Llama por modelo nacional (Maritaca AI) para atender requisitos de soberania de dados do BACEN.',
    'compliance_requirement',
    'discovery',
    'high',
    '00000000-0000-0000-0001-000000000004'
) ON CONFLICT (id) DO NOTHING;

-- Case 2: Integração com SAP S/4HANA
INSERT INTO demand_cases (id, org_id, title, description, source_type, status, priority, requested_by)
VALUES (
    '00000000-0000-0000-000A-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Integração com SAP S/4HANA',
    'Desenvolver conector MCP para permitir que assistentes consultem dados de ERP (pedidos, estoque, fornecedores) com read-only access.',
    'client_request',
    'contracting',
    'medium',
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab'
) ON CONFLICT (id) DO NOTHING;

-- Case 3: Chatbot Multilíngue Atendimento
INSERT INTO demand_cases (id, org_id, title, description, source_type, status, priority, requested_by)
VALUES (
    '00000000-0000-0000-000A-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'Chatbot Multilíngue Atendimento',
    'Expandir o chatbot de atendimento para suportar espanhol e inglês. Requer avaliação de impacto no DLP (detecção de PII em múltiplos idiomas).',
    'catalog_gap',
    'intake',
    'low',
    '00000000-0000-0000-0001-000000000003'
) ON CONFLICT (id) DO NOTHING;

-- ── Review Tracks (3 default tracks for demo org) ────────────────────────────

INSERT INTO review_tracks (id, org_id, name, slug, description, is_required, sla_hours, sort_order)
VALUES
    ('00000000-0000-0000-000D-000000000001', '00000000-0000-0000-0000-000000000001',
     'Revisão Central', 'central',
     'Revisão geral de qualidade, adequação ao caso de uso e alinhamento com padrões da organização.',
     true, 72, 1),
    ('00000000-0000-0000-000D-000000000002', '00000000-0000-0000-0000-000000000001',
     'Revisão de Segurança', 'security',
     'Revisão de conectores, classificação de dados, configuração de guardrails e permissões.',
     true, 48, 2),
    ('00000000-0000-0000-000D-000000000003', '00000000-0000-0000-0000-000000000001',
     'Revisão de Compliance', 'compliance',
     'Revisão de conformidade regulatória, adequação à LGPD, risco de responsabilização.',
     false, 120, 3)
ON CONFLICT (org_id, slug) DO NOTHING;

-- ── Review Decisions (Chatbot Atendimento — currently under_review) ──────────

INSERT INTO review_decisions (id, org_id, assistant_id, track_id, decision, notes, created_at)
VALUES
    ('00000000-0000-0000-000E-000000000001', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0002-000000000005',  -- Chatbot Atendimento
     '00000000-0000-0000-000D-000000000001',  -- Central
     'approved', 'Caso de uso adequado para atendimento N1. Prompts revisados.',
     now() - interval '2 days'),
    ('00000000-0000-0000-000E-000000000002', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0002-000000000005',
     '00000000-0000-0000-000D-000000000002',  -- Segurança
     'pending', NULL, now() - interval '1 day'),
    ('00000000-0000-0000-000E-000000000003', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0002-000000000005',
     '00000000-0000-0000-000D-000000000003',  -- Compliance
     'pending', NULL, now() - interval '1 day')
ON CONFLICT DO NOTHING;

-- ── Review Decisions (Assistente Jurídico — all 3 tracks historically approved) ──

INSERT INTO review_decisions (id, org_id, assistant_id, track_id, reviewer_id, reviewer_email, decision, notes, decided_at, created_at)
VALUES
    ('00000000-0000-0000-000E-000000000004', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-000D-000000000001',
     '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab', 'admin@orga.com',
     'approved', 'Revisão central concluída.',
     now() - interval '50 days', now() - interval '52 days'),
    ('00000000-0000-0000-000E-000000000005', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-000D-000000000002',
     '00000000-0000-0000-0001-000000000004', 'ciso@orga.com',
     'approved', 'Segurança validada. Dados confidenciais com PII blocker ativo.',
     now() - interval '48 days', now() - interval '52 days'),
    ('00000000-0000-0000-000E-000000000006', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-000D-000000000003',
     '00000000-0000-0000-0001-000000000002', 'compliance@orga.com',
     'approved', 'Compliance LGPD validado.',
     now() - interval '46 days', now() - interval '52 days')
ON CONFLICT DO NOTHING;

-- ── Webhook Config (demo) ──────────────────────────────────────────────────

INSERT INTO webhook_configs (id, org_id, name, url, secret, events, is_active)
VALUES (
    '00000000-0000-000F-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Slack #govai-alerts',
    'https://hooks.slack.com/services/DEMO/DEMO/DEMO',
    'demo-hmac-secret',
    ARRAY['approval.pending', 'execution.violation', 'shield.critical_finding'],
    true
) ON CONFLICT DO NOTHING;

-- ── Webhook Deliveries (demo) ──────────────────────────────────────────────

INSERT INTO webhook_deliveries (id, org_id, webhook_id, event, payload, status, response_code, response_body, attempts, next_retry_at)
VALUES
    ('00000000-0000-000F-0001-000000000001', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-000F-0000-000000000001', 'approval.pending',
     '{"event":"approval.pending","orgId":"00000000-0000-0000-0000-000000000001"}',
     'success', 200, 'ok', 1, NULL),
    ('00000000-0000-000F-0001-000000000002', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-000F-0000-000000000001', 'execution.violation',
     '{"event":"execution.violation","orgId":"00000000-0000-0000-0000-000000000001"}',
     'success', 200, 'ok', 1, NULL),
    ('00000000-0000-000F-0001-000000000003', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-000F-0000-000000000001', 'shield.critical_finding',
     '{"event":"shield.critical_finding","orgId":"00000000-0000-0000-0000-000000000001"}',
     'failed', 503, 'Service Unavailable', 4, NULL)
ON CONFLICT DO NOTHING;

-- ── Catalog Favorites (demo) ───────────────────────────────────────────────

INSERT INTO catalog_favorites (user_id, assistant_id, org_id)
VALUES
    ('55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0000-000000000001'),
    ('55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab', '00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ── Retention Config (demo) ────────────────────────────────────────────────

INSERT INTO org_retention_config (org_id, audit_log_retention_days, archive_enabled)
VALUES ('00000000-0000-0000-0000-000000000001', 365, false)
ON CONFLICT (org_id) DO NOTHING;

-- ── MCP Servers + Connector Version Grants (Fase 3a demo) ─────────────────
-- Demonstra integração MCP para Assistente Jurídico.
-- O servidor demo não estará rodando no Docker — execuções gerarão TOOL_CALL_FAILED
-- nos audit logs, provando que o pipeline de auditoria MCP funciona corretamente.

INSERT INTO mcp_servers (id, org_id, name, base_url, status)
VALUES (
    '00000000-0000-0000-0010-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'juridico-tools',
    'http://mcp-juridico:8080',
    'active'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO connector_version_grants (id, org_id, assistant_version_id, mcp_server_id, allowed_tools_jsonb)
VALUES (
    '00000000-0000-0000-0010-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0004-000000000001',   -- Assistente Jurídico v1
    '00000000-0000-0000-0010-000000000001',   -- juridico-tools server
    '["buscar_jurisprudencia", "validar_cnpj", "consultar_processo"]'::jsonb
) ON CONFLICT (assistant_version_id, mcp_server_id) DO UPDATE SET
    allowed_tools_jsonb = EXCLUDED.allowed_tools_jsonb;

COMMIT;
