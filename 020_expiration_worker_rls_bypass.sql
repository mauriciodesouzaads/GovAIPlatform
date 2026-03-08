-- MEL-05: Criar política RLS específica para o expiration worker
-- Permitir que processos de expiração façam bulk update atómico cruzando Tenants.

BEGIN;
DROP POLICY IF EXISTS expiration_worker_policy ON pending_approvals;
CREATE POLICY expiration_worker_policy ON pending_approvals
    FOR UPDATE
    USING (status = 'pending' AND expires_at <= NOW())
    WITH CHECK (status = 'expired');
COMMIT;
