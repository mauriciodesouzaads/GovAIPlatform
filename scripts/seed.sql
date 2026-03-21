-- ============================================================================
-- GovAI Platform — Idempotent Demo Seed
-- ============================================================================
-- Safe to run multiple times. All inserts use ON CONFLICT DO NOTHING.
-- Must run inside a transaction so SET LOCAL app.current_org_id persists
-- for the duration of all RLS-gated inserts.
-- Does NOT include the demo API key (key_hash requires SIGNING_SECRET at
-- runtime); that row is inserted by scripts/seed.sh after computing the HMAC.
-- ============================================================================

BEGIN;

-- Set org context for RLS policies (govai_app is subject to row-level security)
SELECT set_config('app.current_org_id', '00000000-0000-0000-0000-000000000001', true);

-- 1. Default organisation (no RLS on organizations table)
INSERT INTO organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'GovAI Demo Org')
ON CONFLICT (id) DO NOTHING;

-- 2. Admin user  (password: "GovAI2026@Admin", bcrypt cost 12)
-- Credenciais de acesso local:
--   URL:      http://localhost:3001
--   Email:    admin@orga.com
--   Senha:    GovAI2026@Admin
--   Role:     admin (tenant)
INSERT INTO users (
    id, org_id, email, name,
    sso_provider, sso_user_id,
    password_hash, requires_password_change, role
) VALUES (
    '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab',
    '00000000-0000-0000-0000-000000000001',
    'admin@orga.com',
    'Admin',
    'local',
    'admin@orga.com',
    '$2b$12$9f9w9fubYL8Zf04/CtjY5uJRyLm3My/vl69WmbygayoZj9pLsi2aO',
    false,
    'admin'
) ON CONFLICT (id) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    requires_password_change = EXCLUDED.requires_password_change;

-- 3. Published demo assistant
INSERT INTO assistants (id, org_id, name, status)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Assistente GovAI Demo',
    'published'
) ON CONFLICT (id) DO NOTHING;

COMMIT;
