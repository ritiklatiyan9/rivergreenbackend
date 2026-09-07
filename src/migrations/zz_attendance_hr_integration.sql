BEGIN;
ALTER TABLE site_hr_settings ADD COLUMN IF NOT EXISTS salary_basis VARCHAR(20) NOT NULL DEFAULT 'TIME' CHECK (salary_basis IN ('TIME', 'ATTENDANCE'));
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS calculation_snapshot JSONB;
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS adjustment_reason TEXT;
ALTER TABLE attendance_locations ADD COLUMN IF NOT EXISTS zkteco_punch_mode VARCHAR(20) NOT NULL DEFAULT 'AUTO' CHECK (zkteco_punch_mode IN ('AUTO', 'DEVICE'));
CREATE TABLE IF NOT EXISTS attendance_punch_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES attendance_locations(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  punch_time TIMESTAMPTZ NOT NULL,
  punch_type INTEGER,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, location_id, punch_time)
);
CREATE INDEX IF NOT EXISTS attendance_punch_events_day_idx ON attendance_punch_events(user_id, location_id, attendance_date, punch_time);
CREATE INDEX IF NOT EXISTS attendance_punch_events_location_time_idx ON attendance_punch_events(location_id, punch_time);
CREATE INDEX IF NOT EXISTS zkteco_unmapped_location_time_idx ON zkteco_unmapped_punches(location_id, punch_time);
CREATE INDEX IF NOT EXISTS attendance_records_date_user_idx ON attendance_records(date, user_id);
COMMIT;
