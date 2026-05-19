-- Rename LABOUR to STAFF in role CHECK constraint
-- Run once against the database

-- Update any existing users who were created with LABOUR role
UPDATE users SET role = 'STAFF' WHERE role = 'LABOUR';

-- Drop old constraint and re-add with STAFF (replacing LABOUR)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('OWNER', 'ADMIN', 'SUPERVISOR', 'TEAM_HEAD', 'AGENT', 'CLIENT', 'VISITOR', 'STAFF'));
