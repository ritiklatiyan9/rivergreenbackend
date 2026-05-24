-- ============================================================
-- SUB_AGENT role migration
-- Adds the SUB_AGENT role below AGENT in the hierarchy.
-- An AGENT can register SUB_AGENTs who are automatically
-- assigned to the same team with parent_id = the registering agent.
-- No schema change is needed (role is VARCHAR); this file
-- documents the intent and can be run to update any CHECK
-- constraints if they exist.
-- ============================================================

-- If your users table has a CHECK constraint on role, update it:
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
-- ALTER TABLE users ADD CONSTRAINT users_role_check
--   CHECK (role IN ('OWNER','ADMIN','SUPERVISOR','TEAM_HEAD','AGENT','SUB_AGENT','STAFF','CLIENT','VISITOR'));

-- Role hierarchy after this migration:
-- OWNER > ADMIN > SUPERVISOR > TEAM_HEAD > AGENT > SUB_AGENT > STAFF > CLIENT > VISITOR

-- SUB_AGENT users:
--   - role = 'SUB_AGENT'
--   - team_id  = same as the AGENT who registered them
--   - parent_id = the AGENT's id (reference link)
--   - sponsor_id = the AGENT's id
--   - sponsor_code is auto-generated (RG-XXXXXX format)
