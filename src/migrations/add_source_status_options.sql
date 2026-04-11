-- Add new lead_source options: Direct Visit, Calling Visit, Site Visit
-- Drop and re-add the CHECK constraint with all values
ALTER TABLE IF EXISTS leads DROP CONSTRAINT IF EXISTS leads_lead_source_check;
ALTER TABLE IF EXISTS leads
ADD CONSTRAINT leads_lead_source_check
CHECK (lead_source IN ('Direct', 'Referral', 'Website', 'Advertisement', 'Event', 'Other', 'Direct Visit', 'Calling Visit', 'Site Visit'));

-- Add new status options: INCOMING_OFF, SWITCH_OFF, NOT_ANSWERING
ALTER TABLE IF EXISTS leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE IF EXISTS leads
ADD CONSTRAINT leads_status_check
CHECK (status IN ('NEW', 'CONTACTED', 'INTERESTED', 'SITE_VISIT', 'NEGOTIATION', 'BOOKED', 'LOST', 'INCOMING_OFF', 'SWITCH_OFF', 'NOT_ANSWERING'));

-- Also update contacts status constraint if it exists
ALTER TABLE IF EXISTS contacts DROP CONSTRAINT IF EXISTS contacts_status_check;
