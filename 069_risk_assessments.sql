BEGIN;

CREATE TABLE IF NOT EXISTS risk_assessments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    assistant_id UUID NOT NULL REFERENCES assistants(id),
    version_id UUID REFERENCES assistant_versions(id),

    status VARCHAR(20) DEFAULT 'in_progress',

    answers JSONB NOT NULL DEFAULT '{}',

    total_score INTEGER,
    risk_level VARCHAR(20),
    category_scores JSONB,

    assessed_by UUID REFERENCES users(id),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE risk_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_risk_assessments ON risk_assessments
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON risk_assessments TO govai_app;

COMMIT;
