-- ============================================================
-- Switch user "primary office" from a per-attendance-location FK
-- to a per-site FK. Site is the multi-tenant top-level — admins
-- think of "primary office" as which site an employee belongs to,
-- not which specific machine they punch at.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- 1) Add the new column
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS primary_site_id UUID REFERENCES sites(id) ON DELETE SET NULL;

-- 2) Backfill: derive site_id from each user's existing primary attendance location.
--    Falls back to users.site_id when the location had no site_id set yet.
UPDATE users u
SET primary_site_id = COALESCE(al.site_id, u.site_id)
FROM attendance_locations al
WHERE u.primary_site_id IS NULL
  AND u.primary_attendance_location_id IS NOT NULL
  AND al.id = u.primary_attendance_location_id;

-- For users who never had a primary location set, default to their site_id
-- so the BiometricMapping page shows something sensible immediately.
UPDATE users
SET primary_site_id = site_id
WHERE primary_site_id IS NULL AND site_id IS NOT NULL;

-- 3) Replace the per-location uniqueness with per-site uniqueness:
--    one biometric user-id is unique within a site (each site has one device).
DROP INDEX IF EXISTS uq_users_zkteco_per_location;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_zkteco_per_site
  ON users(zkteco_user_id, primary_site_id)
  WHERE zkteco_user_id IS NOT NULL AND primary_site_id IS NOT NULL;

-- 4) Drop the old column. Done last so the backfill above can read it.
ALTER TABLE users DROP COLUMN IF EXISTS primary_attendance_location_id;
