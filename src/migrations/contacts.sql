-- Contacts table for raw phone contacts (name + number)
-- Contacts are converted to leads when a call is made

CREATE TABLE IF NOT EXISTS contacts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    phone       VARCHAR(20)  NOT NULL,
    is_converted BOOLEAN DEFAULT FALSE,
    converted_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Prevent duplicate phone per site
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_site_phone ON contacts(site_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_site_id ON contacts(site_id);
CREATE INDEX IF NOT EXISTS idx_contacts_is_converted ON contacts(is_converted);

-- Auto-update trigger
CREATE OR REPLACE TRIGGER update_contacts_updated_at
    BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Bulk import jobs tracking for contacts
CREATE TABLE IF NOT EXISTS contact_import_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    status      VARCHAR(20) DEFAULT 'QUEUED',
    total_rows  INT DEFAULT 0,
    imported    INT DEFAULT 0,
    failed      INT DEFAULT 0,
    errors      JSONB DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
