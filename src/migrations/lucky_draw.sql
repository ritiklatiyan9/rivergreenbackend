-- Lucky Draw Management Module
-- Fully isolated user namespace (ld_users) so Lucky Draw logins cannot
-- access the main system (sites/leads/etc.). Admin from main `users`
-- table manages everything through a separate admin-only surface.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Reuse the updated_at trigger function if it already exists (created by other migrations)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    CREATE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $f$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $f$ LANGUAGE plpgsql;
  END IF;
END$$;

-- ==========================================================
-- LD_USERS  (Managers + Agents)
-- ==========================================================
CREATE TABLE IF NOT EXISTS ld_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(180) NOT NULL,
  username VARCHAR(120) NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role VARCHAR(24) NOT NULL CHECK (role IN ('PRIME_MANAGER','GENERAL_MANAGER','LD_AGENT')),
  parent_id UUID REFERENCES ld_users(id) ON DELETE SET NULL,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  permissions JSONB NOT NULL DEFAULT '{"canCreate":true,"canEdit":false,"canDelete":false,"canView":true}'::jsonb,
  token_version INTEGER NOT NULL DEFAULT 1,
  last_login_at TIMESTAMPTZ,
  created_by UUID,        -- main users.id (admin)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ld_users_parent     ON ld_users(parent_id);
CREATE INDEX IF NOT EXISTS idx_ld_users_role       ON ld_users(role);
CREATE INDEX IF NOT EXISTS idx_ld_users_site       ON ld_users(site_id);
CREATE INDEX IF NOT EXISTS idx_ld_users_active     ON ld_users(is_active);

DROP TRIGGER IF EXISTS trg_ld_users_updated_at ON ld_users;
CREATE TRIGGER trg_ld_users_updated_at
BEFORE UPDATE ON ld_users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==========================================================
-- LD_EVENTS
-- ==========================================================
CREATE TABLE IF NOT EXISTS ld_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name VARCHAR(200) NOT NULL,
  description TEXT,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED','DRAFT')),
  created_by UUID,                    -- admin main users.id
  serial_counter INTEGER NOT NULL DEFAULT 0,   -- per-event receipt auto-increment
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ld_events_status ON ld_events(status);
CREATE INDEX IF NOT EXISTS idx_ld_events_site   ON ld_events(site_id);

DROP TRIGGER IF EXISTS trg_ld_events_updated_at ON ld_events;
CREATE TRIGGER trg_ld_events_updated_at
BEFORE UPDATE ON ld_events
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==========================================================
-- LD_ENTRIES  (Customer entries)
-- ==========================================================
CREATE TABLE IF NOT EXISTS ld_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES ld_events(id) ON DELETE CASCADE,
  type VARCHAR(16) NOT NULL CHECK (type IN ('PRIME','GENERAL')),
  created_by UUID NOT NULL REFERENCES ld_users(id) ON DELETE RESTRICT,    -- agent
  manager_id UUID REFERENCES ld_users(id) ON DELETE SET NULL,              -- agent's parent
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  alt_phone VARCHAR(32),
  team VARCHAR(120),
  address TEXT,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ld_entries_event       ON ld_entries(event_id);
CREATE INDEX IF NOT EXISTS idx_ld_entries_type        ON ld_entries(type);
CREATE INDEX IF NOT EXISTS idx_ld_entries_created_by  ON ld_entries(created_by);
CREATE INDEX IF NOT EXISTS idx_ld_entries_manager     ON ld_entries(manager_id);
CREATE INDEX IF NOT EXISTS idx_ld_entries_event_type  ON ld_entries(event_id, type);

DROP TRIGGER IF EXISTS trg_ld_entries_updated_at ON ld_entries;
CREATE TRIGGER trg_ld_entries_updated_at
BEFORE UPDATE ON ld_entries
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==========================================================
-- LD_RECEIPTS  (Serial number per event)
-- ==========================================================
CREATE TABLE IF NOT EXISTS ld_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL UNIQUE REFERENCES ld_entries(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES ld_events(id) ON DELETE CASCADE,
  serial_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, serial_number)
);

CREATE INDEX IF NOT EXISTS idx_ld_receipts_event ON ld_receipts(event_id);

-- ==========================================================
-- LD_ACTIVITY_LOGS  (audit trail)
-- ==========================================================
CREATE TABLE IF NOT EXISTS ld_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  actor_role VARCHAR(24),
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(40),
  entity_id UUID,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ld_activity_actor ON ld_activity_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_ld_activity_action ON ld_activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_ld_activity_created ON ld_activity_logs(created_at DESC);
