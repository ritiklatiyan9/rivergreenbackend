-- ============================================================
-- ZKTeco ADMS (Push SDK) integration — extends the existing
-- attendance_locations to support cloud push mode.
-- The device POSTs punches to /iclock/cdata?SN=... so the server
-- only needs the device's serial number to identify it.
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE attendance_locations
  ADD COLUMN IF NOT EXISTS adms_enabled         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS adms_last_heartbeat  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS adms_firmware        VARCHAR(64),
  ADD COLUMN IF NOT EXISTS adms_user_count      INTEGER,
  ADD COLUMN IF NOT EXISTS adms_punch_count     INTEGER,
  ADD COLUMN IF NOT EXISTS adms_last_error      TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_locations_serial
  ON attendance_locations(zkteco_serial)
  WHERE zkteco_serial IS NOT NULL;
