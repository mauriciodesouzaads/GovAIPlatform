-- Migration: 017_add_password_and_roles_to_users.sql
-- Descrição: Otimização da segurança de credenciais e RBAC. 
-- Garante a obrigatoriedade de troca de senha por padrão para todos os novos usuários.

-- 1. Evolução do Schema de Usuários
-- Adição de colunas com tratamento de existência e integridade
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS requires_password_change BOOLEAN DEFAULT TRUE;

-- Garantir que o DEFAULT seja aplicado mesmo que a coluna já existisse sem ele
ALTER TABLE users ALTER COLUMN requires_password_change SET DEFAULT TRUE;

-- Preencher dados legados e aplicar NOT NULL para evitar estados inconsistentes
UPDATE users SET requires_password_change = TRUE WHERE requires_password_change IS NULL;
ALTER TABLE users ALTER COLUMN requires_password_change SET NOT NULL;

-- Adição de Role com Default e Check Constraint
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'operator';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'sre', 'dpo', 'operator', 'auditor'));

-- 2. Injeção Idempotente do Administrador Primordial
-- Definido com requires_password_change = TRUE para conformidade com a política de segurança
DO $$ 
DECLARE
    v_org_id UUID;
    v_admin_email TEXT := 'admin@govai.com';
    -- Hash para a senha padrão 'admin' (Sincronizado com E2E)
    v_default_hash TEXT := '$2b$10$tdILahYIL7M2VDCtwl/w5ePVUtfFXIltAmR6pS8UNN1l22Wnj8Dae';
BEGIN
    -- Busca a organização padrão (Banco Fictício) injetada no setup inicial
    SELECT id INTO v_org_id FROM organizations WHERE name = 'Banco Fictício SA' LIMIT 1;
    
    IF v_org_id IS NOT NULL THEN
        -- Tentar inserir ou atualizar o usuário admin garantindo a flag de segurança
        INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
        VALUES (
            v_org_id, 
            v_admin_email, 
            'Platform Administrator', 
            'local', 
            v_admin_email, 
            v_default_hash, 
            TRUE, 
            'admin'
        )
        ON CONFLICT (sso_provider, sso_user_id) DO UPDATE SET 
            password_hash = EXCLUDED.password_hash,
            requires_password_change = TRUE,
            role = 'admin';
    END IF;
END $$;
