-- ============================================================
-- Multi-session attendance + ADMS device clock sync.
--
-- Adds:
--   attendance_records.sessions  — JSONB array of {in, out} objects.
--                                  check_in_time / check_out_time stay
--                                  populated as denormalized first-in /
--                                  last-completed-out (so existing queries
--                                  keep working).
--   attendance_locations.adms_last_time_sync_at  — when the server last
--                                  pushed a SET DATETIME command to the
--                                  device. Drives the every-6h auto-sync.
--
-- Backfill: existing rows that have check_in_time get a single-session
-- array so the UI doesn't break.
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS sessions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill any existing rows that don't yet have sessions populated.
UPDATE attendance_records
SET sessions = jsonb_build_array(
  jsonb_build_object(
    'in',  to_char(check_in_time AT TIME ZONE 'UTC',  'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'out', CASE
             WHEN check_out_time IS NULL THEN NULL
             ELSE to_char(check_out_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
           END
  )
)
WHERE check_in_time IS NOT NULL
  AND (sessions = '[]'::jsonb OR sessions IS NULL);

ALTER TABLE attendance_locations
  ADD COLUMN IF NOT EXISTS adms_last_time_sync_at TIMESTAMPTZ;
