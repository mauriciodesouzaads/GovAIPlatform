-- Migration 088 — FASE 14.0 Etapa 1
-- =====================================================================
-- Remove UI/rotas/código de workflow. Preserva como órfãs as tabelas
-- cujo FK chain sustenta architect_work_items.workflow_graph_id
-- (NOT NULL FK a workflow_graphs). Zero toque em
-- src/lib/architect-delegation.ts — getAutoDelegationWorkflowGraphId()
-- continua resolvendo o singleton via graph_json->>'marker'.
--
-- Etapa 2 vai renomear architect_work_items → runtime_work_items,
-- remover a coluna workflow_graph_id, e aí sim dropar demand_cases,
-- problem_contracts, architecture_decision_sets, workflow_graphs.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Drop direto: architect_workflow_templates não tem FK reversa.
-- ─────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS architect_workflow_templates CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Deletar linhas de workflow que NÃO estão no chain upstream do
--    singleton auto_delegation. Toda a cadeia abaixo está ligada por
--    ON DELETE CASCADE, então deletar um demand_case órfão propaga
--    para pc → ads → wfg → work_items — mas como esses órfãos não
--    têm contratos/decisão/grafo atrelados (verificado via recon),
--    o cascade não toca o chain do singleton.
--
--    Chain preservado: demand_case (1) → pc (1) → ads (1) → wfg (N,
--    incluindo o marker='auto_delegation'). Fresh installs via
--    seed.sql mantêm essa spine; installs existentes idem.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM demand_cases
 WHERE id NOT IN (
    SELECT dc.id
      FROM demand_cases dc
      JOIN problem_contracts pc  ON pc.demand_case_id = dc.id
      JOIN architecture_decision_sets ads ON ads.problem_contract_id = pc.id
      JOIN workflow_graphs wfg   ON wfg.architecture_decision_set_id = ads.id
     WHERE wfg.graph_json->>'marker' = 'auto_delegation'
 );

-- ─────────────────────────────────────────────────────────────────────
-- 3. Sanity checks — abortar a migration se algo crítico quebrou.
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    -- Tabelas de delegação intactas
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'architect_work_items') THEN
        RAISE EXCEPTION 'architect_work_items foi removido por engano — delegação morta';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'architect_work_item_events') THEN
        RAISE EXCEPTION 'architect_work_item_events removido por engano';
    END IF;

    -- workflow_graphs preservado (órfão, mas necessário para FK)
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'workflow_graphs') THEN
        RAISE EXCEPTION 'workflow_graphs removido — FK de delegation quebrada';
    END IF;

    -- Singleton auto_delegation tem que sobreviver para
    -- getAutoDelegationWorkflowGraphId() não retornar NULL
    IF NOT EXISTS (
        SELECT 1 FROM workflow_graphs
         WHERE graph_json->>'marker' = 'auto_delegation'
    ) THEN
        RAISE EXCEPTION
            'auto_delegation singleton não existe após migração — delegation INSERTs vão falhar com NOT NULL FK';
    END IF;

    -- architect_workflow_templates deve ter sumido
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'architect_workflow_templates') THEN
        RAISE EXCEPTION 'architect_workflow_templates sobreviveu ao DROP — verificar CASCADE';
    END IF;
END $$;

COMMIT;
