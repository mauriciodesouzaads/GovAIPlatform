-- Migration: 018_add_dek_to_encrypted_runs.sql
-- Descrição: Adiciona a coluna para armazenar a Chave de Criptografia de Dados (DEK) cifrada pelo KMS externo (Envelope Encryption).

ALTER TABLE run_content_encrypted 
    ADD COLUMN IF NOT EXISTS encrypted_dek TEXT;
