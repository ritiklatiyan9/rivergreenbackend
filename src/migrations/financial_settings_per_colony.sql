-- Per-colony financial settings (Razorpay keys + booking amount)
-- A row with colony_map_id IS NULL acts as the site-wide default fallback.
ALTER TABLE site_financial_settings
  ADD COLUMN IF NOT EXISTS colony_map_id UUID REFERENCES colony_maps(id) ON DELETE CASCADE;

-- Drop the old single-row-per-site constraint if it exists.
ALTER TABLE site_financial_settings
  DROP CONSTRAINT IF EXISTS site_financial_settings_site_id_key;

-- Allow at most one site-wide default and one row per (site, colony) pair.
CREATE UNIQUE INDEX IF NOT EXISTS site_financial_settings_site_default_uq
  ON site_financial_settings (site_id)
  WHERE colony_map_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS site_financial_settings_site_colony_uq
  ON site_financial_settings (site_id, colony_map_id)
  WHERE colony_map_id IS NOT NULL;
