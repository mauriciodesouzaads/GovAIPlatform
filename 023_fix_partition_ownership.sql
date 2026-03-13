-- Migration: 023_fix_partition_ownership.sql
-- Descrição: Garante que govai_app possui os privilégios DML necessários em todas as
-- tabelas operacionais da plataforma.
--
-- CORREÇÃO DE SEGURANÇA: A versão anterior desta migration usava ALTER TABLE ... OWNER TO,
-- o que concedia direitos DDL (DROP, ALTER, TRUNCATE) à role da aplicação — violando o
-- princípio do menor privilégio. A role govai_app é uma role de aplicação e deve ter apenas
-- DML (SELECT, INSERT, UPDATE, DELETE). O DDL continua exclusivo do superuser postgres.
--
-- As políticas RLS e triggers de auditoria são criadas pelo postgres e não exigem
-- propriedade das tabelas pela role da aplicação.

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs_partitioned TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations             TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys                  TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users                     TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON assistants                TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_bases           TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents                 TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_approvals         TO govai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_hitl_keywords         TO govai_app;
