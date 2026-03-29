-- Migration: Support multiple team heads per team
-- Creates a junction table team_heads to allow many-to-many relationship

CREATE TABLE IF NOT EXISTS team_heads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

-- Migrate existing head_id data from teams table
INSERT INTO team_heads (team_id, user_id)
SELECT id, head_id FROM teams WHERE head_id IS NOT NULL
ON CONFLICT (team_id, user_id) DO NOTHING;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_team_heads_team_id ON team_heads(team_id);
CREATE INDEX IF NOT EXISTS idx_team_heads_user_id ON team_heads(user_id);
