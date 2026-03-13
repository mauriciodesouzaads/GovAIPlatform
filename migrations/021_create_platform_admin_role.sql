-- Migration to create the platform_admin role required for global RLS bypass
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_admin') THEN
        EXECUTE 'CREATE ROLE platform_admin WITH BYPASSRLS';
    END IF;
END
$$;

-- Ensure the connection user can assume this role
GRANT platform_admin TO current_user;
