-- Financial Settings for Sites
-- Admin can configure bank, UPI, and scanner details that show during plot booking
CREATE TABLE IF NOT EXISTS site_financial_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- Bank Details
  bank_name VARCHAR(255),
  account_holder_name VARCHAR(255),
  account_number VARCHAR(50),
  ifsc_code VARCHAR(20),
  bank_branch VARCHAR(255),

  -- UPI Details
  upi_id VARCHAR(255),
  upi_scanner_url TEXT,

  -- Additional
  payment_instructions TEXT,

  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(site_id)
);
