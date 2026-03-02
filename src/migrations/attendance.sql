-- ============================================================
-- Attendance System — Geo-Location Based
-- ============================================================

-- 1) Office / attendance locations set by admin
CREATE TABLE IF NOT EXISTS attendance_locations (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    radius_meters   INTEGER NOT NULL DEFAULT 100,   -- allowed radius in meters
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Daily attendance records
CREATE TABLE IF NOT EXISTS attendance_records (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id     INTEGER NOT NULL REFERENCES attendance_locations(id) ON DELETE CASCADE,
    check_in_time   TIMESTAMPTZ,
    check_out_time  TIMESTAMPTZ,
    check_in_lat    DOUBLE PRECISION,
    check_in_lng    DOUBLE PRECISION,
    check_out_lat   DOUBLE PRECISION,
    check_out_lng   DOUBLE PRECISION,
    check_in_distance_m  DOUBLE PRECISION,  -- actual distance from office when checking in
    check_out_distance_m DOUBLE PRECISION,  -- actual distance from office when checking out
    status          VARCHAR(20) NOT NULL DEFAULT 'PRESENT',  -- PRESENT, LATE, HALF_DAY, ABSENT
    notes           TEXT,
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One check-in per user per day per location
    UNIQUE(user_id, location_id, date)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_attendance_records_user_id ON attendance_records(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_records_date ON attendance_records(date);
CREATE INDEX IF NOT EXISTS idx_attendance_records_user_date ON attendance_records(user_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_locations_active ON attendance_locations(is_active);
