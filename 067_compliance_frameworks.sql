BEGIN;

CREATE TABLE IF NOT EXISTS compliance_frameworks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    version VARCHAR(50),
    region VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_controls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    framework_id UUID NOT NULL REFERENCES compliance_frameworks(id),
    code VARCHAR(50) NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    severity VARCHAR(20) DEFAULT 'required',
    govai_feature VARCHAR(100),
    auto_assessment VARCHAR(20) DEFAULT 'manual',
    sort_order INTEGER DEFAULT 0,
    UNIQUE(framework_id, code)
);

CREATE TABLE IF NOT EXISTS compliance_assessments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    control_id UUID NOT NULL REFERENCES compliance_controls(id),
    status VARCHAR(20) NOT NULL DEFAULT 'not_assessed',
    evidence_notes TEXT,
    assessed_by UUID REFERENCES users(id),
    assessed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, control_id)
);

ALTER TABLE compliance_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_assessments ON compliance_assessments
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON compliance_assessments TO govai_app;
GRANT SELECT ON compliance_frameworks TO govai_app;
GRANT SELECT ON compliance_controls TO govai_app;

COMMIT;
