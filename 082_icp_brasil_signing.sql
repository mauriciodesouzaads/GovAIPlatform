-- Migration: 082_icp_brasil_signing.sql
-- FASE 13.2 — ICP-Brasil digital signatures on evidence
-- ---------------------------------------------------------------------------
-- Enables tenants to register an ICP-Brasil-issued digital certificate
-- (A1 = file or A3 = HSM/PKCS#11) that is used to sign evidence records.
-- Signatures have legal equivalence to handwritten signatures under
-- MP 2.200-2/2001, which CNJ (judiciary) and BACEN require for evidence
-- to be admissible as formal proof.
--
-- Design:
--  - One active certificate per org (enforced by partial unique index).
--  - A1 path: encrypted PEM file + KMS-derived passphrase.
--  - A3 path: PKCS#11 module path + slot id + key label (HSM / SoftHSM2).
--  - evidence_records grows three columns carrying the detached signature,
--    the signing certificate reference, and the signing timestamp.
--  - The existing immutability trigger `prevent_evidence_mutation` still
--    applies; ICP columns MUST be populated at insert time via the
--    `recordEvidence` helper (or a one-time signing step inside the same
--    transaction that creates the record). We allow NULL so older records
--    written before a cert was configured remain valid without signature.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS icp_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Subject / issuer metadata (parsed from the PEM on upload)
    subject_cn TEXT NOT NULL,
    subject_cnpj TEXT,
    issuer_cn TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,

    cert_type TEXT NOT NULL CHECK (cert_type IN ('A1', 'A3')),

    -- A3 / PKCS#11 config
    pkcs11_module_path TEXT,
    pkcs11_slot_id INTEGER,
    pkcs11_key_label TEXT,

    -- A1 / file-based config (encrypted PEM at rest)
    encrypted_key_path TEXT,

    -- Public certificate (always readable, used for signature verification)
    cert_pem TEXT NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deactivated_at TIMESTAMPTZ,

    -- Config integrity: A1 needs a key file, A3 needs an HSM slot
    CHECK (
        (cert_type = 'A1' AND encrypted_key_path IS NOT NULL)
        OR (cert_type = 'A3' AND pkcs11_module_path IS NOT NULL AND pkcs11_slot_id IS NOT NULL)
    )
);

-- One active cert per org — soft-disable keeps history for audit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_icp_certificates_org_active
    ON icp_certificates(org_id)
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_icp_certificates_org_created
    ON icp_certificates(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_icp_certificates_expiry
    ON icp_certificates(valid_until)
    WHERE is_active = true;

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE icp_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_certificates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_icp ON icp_certificates;
CREATE POLICY org_isolation_icp ON icp_certificates
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON icp_certificates TO govai_app;

-- ── evidence_records extension ─────────────────────────────────────────────
-- Columns are nullable: records written before an org configures a cert
-- remain legally valid via the existing HMAC integrity_hash; ICP signing
-- is additive, not a replacement.
ALTER TABLE evidence_records
    ADD COLUMN IF NOT EXISTS icp_signature_base64 TEXT,
    ADD COLUMN IF NOT EXISTS icp_certificate_id UUID REFERENCES icp_certificates(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS icp_signed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_evidence_records_icp_cert
    ON evidence_records(icp_certificate_id)
    WHERE icp_certificate_id IS NOT NULL;

COMMIT;
