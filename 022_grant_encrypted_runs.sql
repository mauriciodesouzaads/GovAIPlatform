-- Migration: 022_grant_encrypted_runs.sql
-- Descrição: Concede permissão mínima necessária (DML) à role da aplicação
-- para acessar a tabela de caixa negra (run_content_encrypted).
-- Usa apenas SELECT/INSERT/UPDATE/DELETE — sem DDL, TRUNCATE ou REFERENCES.

GRANT SELECT, INSERT, UPDATE, DELETE ON run_content_encrypted TO govai_app;
