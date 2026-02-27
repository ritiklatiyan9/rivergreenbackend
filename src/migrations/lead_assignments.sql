-- ============================================================
-- Lead Assignment Tracking System
-- Tracks all lead ownership changes with full audit trail
-- ============================================================

-- Lead assignment history table
CREATE TABLE IF NOT EXISTS lead_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    assigned_from UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Add owner_id column to leads table (the true owner of the lead)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill owner_id from created_by for existing leads
UPDATE leads SET owner_id = created_by WHERE owner_id IS NULL;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_lead_assignments_lead_id ON lead_assignments(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_assignments_assigned_to ON lead_assignments(assigned_to);
CREATE INDEX IF NOT EXISTS idx_lead_assignments_assigned_by ON lead_assignments(assigned_by);
CREATE INDEX IF NOT EXISTS idx_lead_assignments_created_at ON lead_assignments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_owner_id ON leads(owner_id);
