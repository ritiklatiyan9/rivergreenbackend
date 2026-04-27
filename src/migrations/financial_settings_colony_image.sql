-- Per-colony hero/cover image, managed from the admin /settings/financial page.
-- One image per (site, colony) financial-settings row.
ALTER TABLE site_financial_settings
  ADD COLUMN IF NOT EXISTS colony_image_url TEXT;
