-- Ensure baseline site exists for existing ERP data tenancy.
-- This migration is idempotent.

WITH existing_site AS (
  SELECT id
  FROM sites
  WHERE LOWER(TRIM(name)) = LOWER(TRIM('River Green'))
  ORDER BY created_at ASC
  LIMIT 1
), inserted_site AS (
  INSERT INTO sites (name, is_active)
  SELECT 'River Green', TRUE
  WHERE NOT EXISTS (SELECT 1 FROM existing_site)
  RETURNING id
), resolved_site AS (
  SELECT id FROM existing_site
  UNION ALL
  SELECT id FROM inserted_site
  LIMIT 1
)
UPDATE users
SET site_id = (SELECT id FROM resolved_site)
WHERE site_id IS NULL
  AND role <> 'OWNER';
