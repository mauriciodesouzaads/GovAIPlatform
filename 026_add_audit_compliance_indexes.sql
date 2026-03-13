-- Migration: 026_add_audit_compliance_indexes.sql
-- Descrição: Adiciona coluna trace_id e índices de compliance LGPD em audit_logs_partitioned.
--
-- Contexto:
--   1. trace_id (UUID): correlação entre execuções de assistente e entradas de auditoria.
--      A tabela init.sql criou audit_logs_partitioned sem esta coluna — necessária para
--      rastreabilidade ponta-a-ponta (assistente → execução → audit log).
--      ADD COLUMN IF NOT EXISTS é idempotente e seguro para tabelas particionadas
--      (PostgreSQL 11+: a coluna é propagada automaticamente para todas as partições).
--
--   2. Índices de compliance: o endpoint GET /v1/admin/organizations/telemetry-consented
--      e relatórios LGPD filtram audit_logs_partitioned por action =
--      'TELEMETRY_CONSENT_GRANTED' ou 'TELEMETRY_CONSENT_REVOKED'. Sem índice, estas
--      queries fazem seq scan na tabela particionada inteira.
--
-- Índices criados:
--   1. idx_audit_action          — filtro por tipo de ação (compliance reports)
--   2. idx_audit_org_action      — filtro por org_id + action (tenant-level audit)
--   3. idx_audit_created_at_brin — BRIN para range scans eficientes em tabelas grandes
--
-- Segurança: Todos os índices usam IF NOT EXISTS — idempotente em re-runs.

-- ── 1. Adicionar trace_id ─────────────────────────────────────────────────────
-- Rastreabilidade: correlaciona audit logs com spans de execução de assistente.
-- NULL para logs anteriores à migration (registros históricos sem trace).
ALTER TABLE audit_logs_partitioned
    ADD COLUMN IF NOT EXISTS trace_id UUID;

-- ── 2. Índice por action ──────────────────────────────────────────────────────
-- Suporta queries de compliance que listam todos os eventos LGPD
CREATE INDEX IF NOT EXISTS idx_audit_logs_action
    ON audit_logs_partitioned (action)
    WHERE action IN (
        'TELEMETRY_CONSENT_GRANTED',
        'TELEMETRY_CONSENT_REVOKED',
        'POLICY_VIOLATION',
        'APPROVAL_GRANTED',
        'APPROVAL_REJECTED'
    );

-- ── 3. Índice composto org_id + action ────────────────────────────────────────
-- Mais seletivo que o índice simples para queries com WHERE org_id = $1 AND action = $2
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action
    ON audit_logs_partitioned (org_id, action);

-- ── 4. Índice BRIN em created_at ──────────────────────────────────────────────
-- Muito eficiente para tabelas grandes com dados inseridos em ordem cronológica.
-- BRIN tem overhead mínimo de escrita comparado a B-tree.
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at_brin
    ON audit_logs_partitioned USING BRIN (created_at);

-- Atualiza estatísticas para o planner
ANALYZE audit_logs_partitioned;
