-- ============================================================
-- MIGRATION: Public Booking Support + Screenshot Uploads
-- ============================================================

-- Add screenshot_urls (JSON array of file paths) to plot_bookings
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS screenshot_urls JSONB DEFAULT '[]'::jsonb;

-- Add source column to track where booking came from
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS booking_source VARCHAR(30) DEFAULT 'ADMIN';
-- Values: ADMIN, AGENT, PUBLIC

-- Add UPI reference fields to payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS upi_id VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS screenshot_urls JSONB DEFAULT '[]'::jsonb;

-- Index for quick filtering
CREATE INDEX IF NOT EXISTS idx_plot_bookings_source ON plot_bookings(booking_source);
