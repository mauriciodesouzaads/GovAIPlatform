#!/bin/bash
set -e
# 8. Setup Inicial de Teste (Mock Data)
# Script to inject demo tenants into the Database explicitly. Do not use in Production!

export DATABASE_URL="${1:-${DATABASE_URL:-"postgresql://govai_app:${DB_APP_PASSWORD:-govai_ci_pass}@localhost:5432/govai_platform"}}"

# Debug help (hidden in CI but useful for logging redirection)
echo "Running seed on: $(echo $DATABASE_URL | sed 's/:.*@/:****@/')"

psql "$DATABASE_URL" <<'EOF'
INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Banco Fictício SA') ON CONFLICT DO NOTHING;

INSERT INTO assistants (id, org_id, name, status) VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'Análise de Risco V1', 'published') ON CONFLICT DO NOTHING;

-- Admin account (password: admin — ATENÇÃO: senha curta, requer troca obrigatória via UI)
-- NOTA: Este usuário tem requires_password_change=true e senha "admin" (< 8 chars).
-- O endpoint /v1/admin/login rejeita senhas < 8 chars (Zod min(8)).
-- Para testes de integração use: admin@orga.com / password (vide abaixo).
INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin@govai.com', 'Admin GovAI', 'local', 'admin@govai.com',
  '$2b$10$tdILahYIL7M2VDCtwl/w5ePVUtfFXIltAmR6pS8UNN1l22Wnj8Dae', true, 'admin')
ON CONFLICT (sso_provider, sso_user_id) DO UPDATE SET 
  password_hash = EXCLUDED.password_hash,
  requires_password_change = EXCLUDED.requires_password_change,
  role = EXCLUDED.role;

-- Operator account (password: admin — mesma ressalva: senha < 8 chars, use apenas para setup)
INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'operator@test.com', 'Operador', 'local', 'operator@test.com',
  '$2b$10$tdILahYIL7M2VDCtwl/w5ePVUtfFXIltAmR6pS8UNN1l22Wnj8Dae', false, 'operator')
ON CONFLICT (sso_provider, sso_user_id) DO UPDATE SET 
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role;

-- Admin Orga (password: password) — CONTA PRINCIPAL DE TESTES: admin@orga.com / password
-- Senha com 8+ chars, compatível com validação Zod. Use esta conta para curl/testes.
INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin@orga.com', 'Admin Orga', 'local', 'admin@orga.com',
  '$2b$10$xWtdHDgYIWsGXCBqmik9dewFZFxyOsJX7akXSnzE1lnWbc6yOyEV6', false, 'admin')
ON CONFLICT (sso_provider, sso_user_id) DO UPDATE SET 
  password_hash = EXCLUDED.password_hash,
  requires_password_change = EXCLUDED.requires_password_change,
  role = EXCLUDED.role;
EOF

echo "Demo Seed executed successfully!"
