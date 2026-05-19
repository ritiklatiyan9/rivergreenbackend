-- Add LABOUR role to users role constraint
-- Run this migration once against the database

-- Drop the existing unnamed check constraint (PostgreSQL auto-names it users_role_check)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

-- Re-add with LABOUR included
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('OWNER', 'ADMIN', 'SUPERVISOR', 'TEAM_HEAD', 'AGENT', 'CLIENT', 'VISITOR', 'LABOUR'));
