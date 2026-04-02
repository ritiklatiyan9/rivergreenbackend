-- Add Razorpay credentials and default booking amount to financial settings
ALTER TABLE site_financial_settings
  ADD COLUMN IF NOT EXISTS razorpay_key_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS razorpay_key_secret VARCHAR(255),
  ADD COLUMN IF NOT EXISTS default_booking_amount DECIMAL(12,2) DEFAULT 0;
