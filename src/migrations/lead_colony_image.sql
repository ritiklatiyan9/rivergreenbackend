-- Add colony image (separate from the lead's profile photo) to leads table.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS colony_image_url TEXT;
