-- ============================================================
-- ZKTeco K40 Pro Integration — extends the existing
-- attendance_locations / attendance_records / users tables.
-- Idempotent: safe to re-run.
-- ============================================================

-- 1) Per-location ZKTeco device config + multi-tenant site link
ALTER TABLE attendance_locations
  ADD COLUMN IF NOT EXISTS site_id                UUID REFERENCES sites(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS zkteco_enabled         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zkteco_ip              VARCHAR(45),
  ADD COLUMN IF NOT EXISTS zkteco_port            INTEGER     NOT NULL DEFAULT 4370,
  ADD COLUMN IF NOT EXISTS zkteco_device_id       INTEGER,
  ADD COLUMN IF NOT EXISTS zkteco_serial          VARCHAR(64),
  ADD COLUMN IF NOT EXISTS zkteco_last_synced_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS zkteco_last_log_id     BIGINT,
  ADD COLUMN IF NOT EXISTS zkteco_last_error      TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_locations_site_id
  ON attendance_locations(site_id);

-- 2) Per-user biometric mapping + primary office
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS zkteco_user_id                  INTEGER,
  ADD COLUMN IF NOT EXISTS primary_attendance_location_id  INTEGER REFERENCES attendance_locations(id) ON DELETE SET NULL;

-- ZKTeco user-id is unique within a device (location)
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_zkteco_per_location
  ON users(zkteco_user_id, primary_attendance_location_id)
  WHERE zkteco_user_id IS NOT NULL AND primary_attendance_location_id IS NOT NULL;

-- 3) Source + secondary flag + raw payload on attendance_records
ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS source        VARCHAR(16) NOT NULL DEFAULT 'GPS',  -- BIOMETRIC | GPS | MANUAL
  ADD COLUMN IF NOT EXISTS is_secondary  BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS raw_zkteco    JSONB;

CREATE INDEX IF NOT EXISTS idx_attendance_records_source
  ON attendance_records(source, date);

-- 4) Inbox for punches whose ZKTeco user-id is not yet mapped
CREATE TABLE IF NOT EXISTS zkteco_unmapped_punches (
  id              BIGSERIAL PRIMARY KEY,
  location_id     INTEGER NOT NULL REFERENCES attendance_locations(id) ON DELETE CASCADE,
  zkteco_user_id  INTEGER NOT NULL,
  punch_time      TIMESTAMPTZ NOT NULL,
  punch_type      INTEGER,
  raw             JSONB,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unmapped_unresolved
  ON zkteco_unmapped_punches(location_id, resolved, punch_time DESC);
