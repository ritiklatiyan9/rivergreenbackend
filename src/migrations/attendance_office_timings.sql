-- ============================================================
-- Attendance System — Add Office Timings
-- ============================================================

-- Add office_start_time to attendance_locations so admin can set 
-- the expected arrival time per location (used for LATE detection)
ALTER TABLE attendance_locations
  ADD COLUMN IF NOT EXISTS office_start_time TIME NOT NULL DEFAULT '10:00:00';

-- Add office_end_time for reference (optional)
ALTER TABLE attendance_locations
  ADD COLUMN IF NOT EXISTS office_end_time TIME NOT NULL DEFAULT '19:00:00';
