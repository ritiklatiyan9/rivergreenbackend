-- Migration: Sidebar permissions per user
-- Date: 2026-04-25
-- Description: Stores which sidebar modules each user is allowed to see.
--              If a user has zero rows here the application falls back to the
--              role-default module set defined in src/config/sidebarModules.js.

CREATE TABLE IF NOT EXISTS user_sidebar_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_user_sidebar_permissions_user_id
  ON user_sidebar_permissions(user_id);
