-- Migration: Add SUPERVISOR role to users table
-- Date: 2026-04-19
-- Description: Adds SUPERVISOR role to the role CHECK constraint and creates
--              the supervisor_site_access table for assigning multiple sites
--              to supervisors.

-- 1. Drop and recreate the role CHECK constraint to include SUPERVISOR
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('OWNER', 'ADMIN', 'SUPERVISOR', 'TEAM_HEAD', 'AGENT', 'CLIENT', 'VISITOR'));

-- 2. Create supervisor_site_access table for multi-site assignment
CREATE TABLE IF NOT EXISTS supervisor_site_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supervisor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supervisor_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_supervisor_site_access_supervisor_id ON supervisor_site_access(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_supervisor_site_access_site_id ON supervisor_site_access(site_id);
