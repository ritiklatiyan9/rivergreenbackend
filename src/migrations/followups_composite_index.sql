-- Composite index for the most common query pattern on followups:
-- Agent scope: site_id + assigned_to + status + scheduled_at
-- This covers getScheduledFollowups (AGENT) and getMissedFollowups with ORDER BY scheduled_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_followups_agent_scope
  ON followups(site_id, assigned_to, status, scheduled_at);

-- Team HEAD scope: covers team-based queries joined on users.team_id
-- Partial index for non-completed followups to keep index lean
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_followups_active
  ON followups(site_id, status, scheduled_at)
  WHERE status IN ('PENDING', 'SNOOZED');
