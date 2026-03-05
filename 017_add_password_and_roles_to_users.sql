-- Migration: 017_add_password_and_roles_to_users.sql
-- Descrição: Introduz credenciais locais (hash bcrypt), obrigatoriedade de troca de senha e Roles (RBAC) para gestão Enterprise.

-- 1. Adicionar colunas à tabela users
ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS password_hash TEXT,
    ADD COLUMN IF NOT EXISTS requires_password_change BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'operator' CHECK (role IN ('admin', 'sre', 'dpo', 'operator', 'auditor'));

-- Permitir que contas SSO locais tenham sso_user_id nulo ou diferente (já que o login local não usará SSO ID)
-- A constraint única 'unique_sso_user' exige valores não-nulos. 
-- Para contas locais puras, 'sso_provider' = 'local' e 'sso_user_id' pode armazenar o próprio email temporariamente, ou podemos dropar a restrição de NOT NULL.
-- Como já existe NOT NULL em sso_user_id, vamos usar o próprio e-mail como sso_user_id para a conta local default.

-- 2. Injetar a conta Admin Primordial
-- Definiremos a hash bcrypt para 'admin' temporariamente, mas forçando a requisição de troca.
-- Hash gerado de antemão para bcrypt('admin', 10) = $2b$10$WpONX.8A2yA1/I40ZgXFZe9D/1z3o0I/I/tqB1tLpKz/u.W2qEOWC
DO $$ 
DECLARE
    v_org_id UUID;
    v_admin_email TEXT := 'admin@govai.com';
BEGIN
    SELECT id INTO v_org_id FROM organizations WHERE name = 'Banco Fictício SA' LIMIT 1;
    
    -- Se por acaso a org não existir, não inserimos para não quebrar constraints
    IF v_org_id IS NOT NULL THEN
        -- Tentar inserir ou atualizar o usuário admin
        INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role)
        VALUES (
            v_org_id, 
            v_admin_email, 
            'Administrator', 
            'local', 
            v_admin_email, 
            '$2b$10$WpONX.8A2yA1/I40ZgXFZe9D/1z3o0I/I/tqB1tLpKz/u.W2qEOWC', 
            TRUE, 
            'admin'
        )
        ON CONFLICT (sso_provider, sso_user_id) DO UPDATE SET 
            password_hash = '$2b$10$WpONX.8A2yA1/I40ZgXFZe9D/1z3o0I/I/tqB1tLpKz/u.W2qEOWC',
            requires_password_change = TRUE,
            role = 'admin';
    END IF;
END $$;
