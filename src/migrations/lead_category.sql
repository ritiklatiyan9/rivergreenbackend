-- Add lead_category column to leads table for lead quality classification
ALTER TABLE IF EXISTS leads
ADD COLUMN IF NOT EXISTS lead_category VARCHAR(20) DEFAULT NULL
  CHECK (lead_category IS NULL OR lead_category IN ('PRIME', 'HOT', 'NORMAL', 'COLD', 'DEAD'));

-- Add index for filtering by lead_category
CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(lead_category);
