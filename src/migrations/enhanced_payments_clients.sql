-- ============================================================
-- MIGRATION: Enhanced Payment Details & Clients View
-- ============================================================

-- ─── Add detailed payment fields to payments table ───────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_number VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS upi_id VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cheque_number VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cheque_date DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(4);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_network VARCHAR(20);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_time TIME;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS collected_by_name VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verification_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS remarks TEXT;

-- Allow payments to be recorded without an associated booking (e.g., cash collection at site)
ALTER TABLE payments ALTER COLUMN booking_id DROP NOT NULL;

-- ─── Add client-related fields to plot_bookings ──────────────
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS client_aadhar VARCHAR(20);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS client_pan VARCHAR(15);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS client_dob DATE;
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS client_occupation VARCHAR(100);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS client_company VARCHAR(255);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS nominee_name VARCHAR(255);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS nominee_phone VARCHAR(50);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS nominee_relation VARCHAR(50);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100);
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS registration_date DATE;
ALTER TABLE plot_bookings ADD COLUMN IF NOT EXISTS possession_date DATE;

-- ============================================================
-- Backfill existing bookings: prefer plot total_price when booking total is missing
-- ============================================================
-- Set plot_bookings.total_amount from map_plots.total_price when missing or zero
UPDATE plot_bookings pb
SET total_amount = mp.total_price
FROM map_plots mp
WHERE pb.plot_id = mp.id
	AND (pb.total_amount IS NULL OR pb.total_amount = 0);

-- Ensure booking_amount is set (fallback to total_amount if missing)
UPDATE plot_bookings
SET booking_amount = COALESCE(booking_amount, total_amount)
WHERE booking_amount IS NULL OR booking_amount = 0;

