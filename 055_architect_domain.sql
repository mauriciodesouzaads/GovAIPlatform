-- ============================================================================
-- Migration 055: Architect Domain
--
-- Creates the five core tables of the Architect domain:
--   demand_cases, problem_contracts, architecture_decision_sets,
--   workflow_graphs, architect_work_items
--
-- All tables include:
--   - RLS by org_id (govai_app policy)
--   - Immutability triggers for terminal states
--   - GRANT SELECT, INSERT, UPDATE to govai_app
--   - updated_at auto-update triggers
-- ============================================================================

BEGIN;

-- ── TABLE 1: demand_cases ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS demand_cases (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id        UUID        NOT NULL REFERENCES organizations(id)
                                ON DELETE CASCADE,
    title         TEXT        NOT NULL,
    description   TEXT,
    source_type   TEXT        NOT NULL
        CHECK (source_type IN ('client_request','internal',
               'shield_finding','catalog_gap','compliance_requirement')),
    source_ref    UUID,
    status        TEXT        NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','intake','discovery','contracting',
               'decision','compiling','delegated','closed')),
    priority      TEXT        NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low','medium','high','critical')),
    requested_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    assigned_to   UUID        REFERENCES users(id) ON DELETE SET NULL,
    due_at        TIMESTAMPTZ,
    closed_at     TIMESTAMPTZ,
    closed_reason TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_demand_cases_org_status
    ON demand_cases(org_id, status);
CREATE INDEX IF NOT EXISTS idx_demand_cases_org_priority
    ON demand_cases(org_id, priority);
CREATE INDEX IF NOT EXISTS idx_demand_cases_assigned
    ON demand_cases(assigned_to);

CREATE OR REPLACE FUNCTION update_demand_case_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_demand_cases_updated_at ON demand_cases;
CREATE TRIGGER trg_demand_cases_updated_at
    BEFORE UPDATE ON demand_cases
    FOR EACH ROW EXECUTE FUNCTION update_demand_case_updated_at();

ALTER TABLE demand_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demand_cases_isolation ON demand_cases;
CREATE POLICY demand_cases_isolation ON demand_cases
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON demand_cases TO govai_app;

-- ── TABLE 2: problem_contracts ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS problem_contracts (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id                   UUID NOT NULL REFERENCES organizations(id)
                               ON DELETE CASCADE,
    demand_case_id           UUID NOT NULL REFERENCES demand_cases(id)
                               ON DELETE CASCADE UNIQUE,
    version                  INTEGER NOT NULL DEFAULT 1,
    goal                     TEXT NOT NULL,
    constraints_json         JSONB NOT NULL DEFAULT '[]',
    non_goals_json           JSONB NOT NULL DEFAULT '[]',
    acceptance_criteria_json JSONB NOT NULL DEFAULT '[]',
    open_questions_json      JSONB NOT NULL DEFAULT '[]',
    context_snippets_json    JSONB NOT NULL DEFAULT '[]',
    confidence_score         INTEGER DEFAULT 0
        CHECK (confidence_score BETWEEN 0 AND 100),
    status                   TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','in_review','accepted','rejected')),
    accepted_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    accepted_at              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_problem_contracts_org_case
    ON problem_contracts(org_id, demand_case_id);
CREATE INDEX IF NOT EXISTS idx_problem_contracts_status
    ON problem_contracts(org_id, status);

CREATE OR REPLACE FUNCTION prevent_problem_contract_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'accepted' THEN
        RAISE EXCEPTION 'problem_contracts is immutable after acceptance';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_problem_contract_immutable ON problem_contracts;
CREATE TRIGGER trg_problem_contract_immutable
    BEFORE UPDATE ON problem_contracts
    FOR EACH ROW EXECUTE FUNCTION prevent_problem_contract_mutation();

CREATE OR REPLACE FUNCTION prevent_problem_contract_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'accepted' THEN
        RAISE EXCEPTION 'problem_contracts is immutable after acceptance';
    END IF;
    RETURN OLD;
END; $$;

DROP TRIGGER IF EXISTS trg_problem_contract_no_delete ON problem_contracts;
CREATE TRIGGER trg_problem_contract_no_delete
    BEFORE DELETE ON problem_contracts
    FOR EACH ROW EXECUTE FUNCTION prevent_problem_contract_delete();

ALTER TABLE problem_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem_contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS problem_contracts_isolation ON problem_contracts;
CREATE POLICY problem_contracts_isolation ON problem_contracts
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON problem_contracts TO govai_app;

-- ── TABLE 3: architecture_decision_sets ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS architecture_decision_sets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id              UUID NOT NULL REFERENCES organizations(id)
                          ON DELETE CASCADE,
    problem_contract_id UUID NOT NULL REFERENCES problem_contracts(id)
                          ON DELETE CASCADE,
    recommended_option  TEXT NOT NULL,
    alternatives_json   JSONB NOT NULL DEFAULT '[]',
    tradeoffs_json      JSONB NOT NULL DEFAULT '[]',
    risks_json          JSONB NOT NULL DEFAULT '[]',
    rationale_md        TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','proposed','approved','rejected')),
    proposed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    proposed_at         TIMESTAMPTZ,
    approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arch_decisions_contract
    ON architecture_decision_sets(org_id, problem_contract_id);
CREATE INDEX IF NOT EXISTS idx_arch_decisions_status
    ON architecture_decision_sets(org_id, status);

CREATE OR REPLACE FUNCTION prevent_arch_decision_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'approved' THEN
        RAISE EXCEPTION 'architecture_decision_sets is immutable after approval';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_arch_decision_immutable ON architecture_decision_sets;
CREATE TRIGGER trg_arch_decision_immutable
    BEFORE UPDATE ON architecture_decision_sets
    FOR EACH ROW EXECUTE FUNCTION prevent_arch_decision_mutation();

ALTER TABLE architecture_decision_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE architecture_decision_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arch_decisions_isolation ON architecture_decision_sets;
CREATE POLICY arch_decisions_isolation ON architecture_decision_sets
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON architecture_decision_sets TO govai_app;

-- ── TABLE 4: workflow_graphs ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_graphs (
    id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id                       UUID NOT NULL REFERENCES organizations(id)
                                   ON DELETE CASCADE,
    architecture_decision_set_id UUID NOT NULL
        REFERENCES architecture_decision_sets(id) ON DELETE CASCADE,
    version                      INTEGER NOT NULL DEFAULT 1,
    graph_json                   JSONB NOT NULL DEFAULT '{}',
    status                       TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','compiled','delegated','completed')),
    compiled_at                  TIMESTAMPTZ,
    delegated_at                 TIMESTAMPTZ,
    completed_at                 TIMESTAMPTZ,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_graphs_decision
    ON workflow_graphs(org_id, architecture_decision_set_id);
CREATE INDEX IF NOT EXISTS idx_workflow_graphs_status
    ON workflow_graphs(org_id, status);

CREATE OR REPLACE FUNCTION prevent_workflow_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'workflow_graphs is immutable after completion';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_workflow_immutable ON workflow_graphs;
CREATE TRIGGER trg_workflow_immutable
    BEFORE UPDATE ON workflow_graphs
    FOR EACH ROW EXECUTE FUNCTION prevent_workflow_mutation();

ALTER TABLE workflow_graphs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_graphs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_graphs_isolation ON workflow_graphs;
CREATE POLICY workflow_graphs_isolation ON workflow_graphs
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON workflow_graphs TO govai_app;

-- ── TABLE 5: architect_work_items ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS architect_work_items (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id            UUID NOT NULL REFERENCES organizations(id)
                        ON DELETE CASCADE,
    workflow_graph_id UUID NOT NULL REFERENCES workflow_graphs(id)
                        ON DELETE CASCADE,
    node_id           TEXT NOT NULL,
    item_type         TEXT NOT NULL
        CHECK (item_type IN (
            'shield_review',
            'catalog_review',
            'policy_config',
            'compliance_check',
            'human_task',
            'rag_research'
        )),
    title             TEXT NOT NULL,
    description       TEXT,
    ref_type          TEXT,
    ref_id            UUID,
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','in_progress','done','blocked','cancelled')),
    assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
    due_at            TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    result_ref        UUID,
    result_notes      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_items_graph
    ON architect_work_items(workflow_graph_id, status);
CREATE INDEX IF NOT EXISTS idx_work_items_org_status
    ON architect_work_items(org_id, status);
CREATE INDEX IF NOT EXISTS idx_work_items_assigned
    ON architect_work_items(assigned_to, status);

CREATE OR REPLACE FUNCTION update_work_item_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_work_items_updated_at ON architect_work_items;
CREATE TRIGGER trg_work_items_updated_at
    BEFORE UPDATE ON architect_work_items
    FOR EACH ROW EXECUTE FUNCTION update_work_item_updated_at();

ALTER TABLE architect_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE architect_work_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_items_isolation ON architect_work_items;
CREATE POLICY work_items_isolation ON architect_work_items
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON architect_work_items TO govai_app;

COMMIT;
