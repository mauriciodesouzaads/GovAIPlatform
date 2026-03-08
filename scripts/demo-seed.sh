#!/bin/bash
# 8. Setup Inicial de Teste (Mock Data)
# Script to inject demo tenants into the Database explicitly. Do not use in Production!

export DATABASE_URL="${1:-${DATABASE_URL:-"postgresql://postgres:postgres@localhost:5432/govai"}}"


psql "$DATABASE_URL" <<EOF
INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Banco Fictício SA') ON CONFLICT DO NOTHING;

INSERT INTO assistants (id, org_id, name, status) VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'Análise de Risco V1', 'published') ON CONFLICT DO NOTHING;

-- Admin account (password: admin)
INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin@govai.com', 'Admin GovAI', 'local', 'admin@govai.com', 
  '$2b$10$WpONX.8A2yA1/I40ZgXFZe9D/1z3o0I/I/tqB1tLpKz/u.W2qEOWC', TRUE, 'admin')
ON CONFLICT (sso_provider, sso_user_id) DO UPDATE SET 
  password_hash = EXCLUDED.password_hash,
  requires_password_change = EXCLUDED.requires_password_change,
  role = EXCLUDED.role;

-- Operator account (password: admin)
INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'operator@test.com', 'Operador', 'local', 'operator@test.com',
  '$2b$10$WpONX.8A2yA1/I40ZgXFZe9D/1z3o0I/I/tqB1tLpKz/u.W2qEOWC', FALSE, 'operator')
ON CONFLICT (sso_provider, sso_user_id) DO UPDATE SET 
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role;
EOF

echo "Demo Seed executed successfully!"
