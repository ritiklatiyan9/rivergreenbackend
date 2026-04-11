-- Add status and lead_category columns to contacts table
-- Mirrors the same fields from leads so contacts can be filtered independently

ALTER TABLE contacts
ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT NULL
  CHECK (status IS NULL OR status IN ('NEW', 'CONTACTED', 'INTERESTED', 'SITE_VISIT', 'NEGOTIATION', 'BOOKED', 'LOST'));

ALTER TABLE contacts
ADD COLUMN IF NOT EXISTS lead_category VARCHAR(20) DEFAULT NULL
  CHECK (lead_category IS NULL OR lead_category IN ('PRIME', 'HOT', 'NORMAL', 'COLD', 'DEAD'));

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_category ON contacts(lead_category);

-- Backfill: sync status and lead_category from linked leads for already-converted contacts
UPDATE contacts c
SET status = l.status,
    lead_category = l.lead_category
FROM leads l
WHERE c.converted_lead_id = l.id
  AND c.is_converted = true
  AND (c.status IS NULL OR c.lead_category IS NULL);
