BEGIN;

CREATE TABLE IF NOT EXISTS model_cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    assistant_id UUID NOT NULL REFERENCES assistants(id),

    model_provider VARCHAR(255),
    model_name VARCHAR(255),
    model_version VARCHAR(100),

    training_data_description TEXT,
    training_data_cutoff DATE,
    fine_tuning_description TEXT,

    known_limitations TEXT,
    known_biases TEXT,
    out_of_scope_uses TEXT,
    ethical_considerations TEXT,

    performance_metrics JSONB DEFAULT '{}',

    business_owner_id UUID REFERENCES users(id),
    technical_owner_id UUID REFERENCES users(id),
    dpo_reviewer_id UUID REFERENCES users(id),
    last_review_date DATE,
    next_review_date DATE,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(org_id, assistant_id)
);

ALTER TABLE model_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_model_cards ON model_cards
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON model_cards TO govai_app;

COMMIT;
