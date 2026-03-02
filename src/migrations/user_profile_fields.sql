-- Add profile fields to users table for agent/team-head profiles
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;

-- Add photo_url to leads table for lead profile images
ALTER TABLE leads ADD COLUMN IF NOT EXISTS photo_url TEXT;
