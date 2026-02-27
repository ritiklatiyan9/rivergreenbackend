-- Add lead_source column to leads table
ALTER TABLE IF EXISTS leads
ADD COLUMN IF NOT EXISTS lead_source VARCHAR(50) DEFAULT 'Other'
  CHECK (lead_source IN ('Direct', 'Referral', 'Website', 'Advertisement', 'Event', 'Other'));

-- Add index for filtering by lead_source
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(lead_source);
