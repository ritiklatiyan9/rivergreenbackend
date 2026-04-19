-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- SITES TABLE (Multi-tenant: each site is a real estate project)
-- ============================================================
CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID, -- owner who created this site
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sites_created_by ON sites(created_by);
CREATE INDEX IF NOT EXISTS idx_sites_active ON sites(is_active);

-- ============================================================
-- USERS TABLE (All roles with site scoping for multi-tenancy)
-- ============================================================
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'VISITOR'
    CHECK (role IN ('OWNER', 'ADMIN', 'SUPERVISOR', 'TEAM_HEAD', 'AGENT', 'CLIENT', 'VISITOR')),

  -- Multi-tenant: which site this user belongs to (NULL for OWNER)
  site_id UUID REFERENCES sites(id) ON DELETE CASCADE,

  -- Sponsor / Referral tracking
  sponsor_code VARCHAR(20) UNIQUE NOT NULL,  -- e.g. RG-A1B2C3
  sponsor_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- who referred this user

  -- Hierarchy: direct manager/parent
  parent_id UUID REFERENCES users(id) ON DELETE SET NULL,

  is_active BOOLEAN DEFAULT TRUE,
  refresh_token VARCHAR(500),
  token_version INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_site_id ON users(site_id);
CREATE INDEX IF NOT EXISTS idx_users_sponsor_code ON users(sponsor_code);
CREATE INDEX IF NOT EXISTS idx_users_sponsor_id ON users(sponsor_id);
CREATE INDEX IF NOT EXISTS idx_users_parent_id ON users(parent_id);

-- ============================================================
-- TEAMS TABLE (within a site)
-- ============================================================
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  head_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_site_id ON teams(site_id);
CREATE INDEX IF NOT EXISTS idx_teams_head_id ON teams(head_id);

-- Add team_id to users (nullable — not every user belongs to a team)
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);

-- ============================================================
-- LEADS TABLE (tracked per agent/team)
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  profession VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW', 'CONTACTED', 'INTERESTED', 'SITE_VISIT', 'NEGOTIATION', 'BOOKED', 'LOST')),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_site_id ON leads(site_id);
CREATE INDEX IF NOT EXISTS idx_leads_team_id ON leads(team_id);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

-- ============================================================
-- BOOKINGS TABLE (conversions from leads)
-- ============================================================
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  booked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  client_name VARCHAR(255),
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  booking_date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_site_id ON bookings(site_id);
CREATE INDEX IF NOT EXISTS idx_bookings_team_id ON bookings(team_id);
CREATE INDEX IF NOT EXISTS idx_bookings_booked_by ON bookings(booked_by);

-- ============================================================
-- TEAM TARGETS TABLE (monthly targets per team)
-- ============================================================
CREATE TABLE IF NOT EXISTS team_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INTEGER NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  lead_target INTEGER DEFAULT 0,
  booking_target INTEGER DEFAULT 0,
  revenue_target NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (team_id, month, year)
);

CREATE INDEX IF NOT EXISTS idx_team_targets_team_id ON team_targets(team_id);

-- ============================================================
-- USER CATEGORIES TABLE (Admin-managed registration categories)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  field_groups TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_categories_site_id ON user_categories(site_id);
CREATE INDEX IF NOT EXISTS idx_user_categories_active ON user_categories(is_active);

-- ============================================================
-- USER PROFILES TABLE (Extended profile data as JSONB)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  category_id UUID REFERENCES user_categories(id) ON DELETE SET NULL,
  profile_data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_site_id ON user_profiles(site_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_category_id ON user_profiles(category_id);

-- ============================================================
-- ADD EXTRA COLUMNS TO USERS TABLE
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'Active'
  CHECK (account_status IN ('Active', 'Pending', 'Suspended'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS alternate_mobile VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_sites_updated_at ON sites;
CREATE TRIGGER update_sites_updated_at
  BEFORE UPDATE ON sites
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_teams_updated_at ON teams;
CREATE TRIGGER update_teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_leads_updated_at ON leads;
CREATE TRIGGER update_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bookings_updated_at ON bookings;
CREATE TRIGGER update_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_team_targets_updated_at ON team_targets;
CREATE TRIGGER update_team_targets_updated_at
  BEFORE UPDATE ON team_targets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_categories_updated_at ON user_categories;
CREATE TRIGGER update_user_categories_updated_at
  BEFORE UPDATE ON user_categories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- CALL OUTCOMES TABLE (master list per site)
-- ============================================================
CREATE TABLE IF NOT EXISTS call_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,
  requires_followup BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_outcomes_site_id ON call_outcomes(site_id);

-- ============================================================
-- CALLS TABLE (call logs per site)
-- ============================================================
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  call_type VARCHAR(20) NOT NULL DEFAULT 'OUTGOING'
    CHECK (call_type IN ('INCOMING', 'OUTGOING')),
  call_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  call_end TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER DEFAULT 0,
  outcome_id UUID REFERENCES call_outcomes(id) ON DELETE SET NULL,
  next_action VARCHAR(30) DEFAULT 'NONE'
    CHECK (next_action IN ('NONE', 'FOLLOW_UP', 'VISIT', 'CLOSE', 'NO_RESPONSE')),
  customer_notes TEXT,
  customer_words TEXT,
  agent_action TEXT,
  buying_timeline VARCHAR(100),
  budget_confirmation VARCHAR(100),
  visit_preference_date DATE,
  specific_requests TEXT,
  rejection_reason TEXT,
  is_manual_log BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_site_id ON calls(site_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead_id ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_assigned_to ON calls(assigned_to);
CREATE INDEX IF NOT EXISTS idx_calls_call_start ON calls(call_start);
CREATE INDEX IF NOT EXISTS idx_calls_outcome_id ON calls(outcome_id);

-- ============================================================
-- FOLLOWUPS TABLE (scheduled follow-up actions)
-- ============================================================
CREATE TABLE IF NOT EXISTS followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  followup_type VARCHAR(20) DEFAULT 'CALL'
    CHECK (followup_type IN ('CALL', 'VISIT', 'WHATSAPP', 'MEETING')),
  status VARCHAR(20) DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'COMPLETED', 'SNOOZED', 'ESCALATED', 'CANCELLED')),
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  snoozed_until TIMESTAMP WITH TIME ZONE,
  escalated_to UUID REFERENCES users(id) ON DELETE SET NULL,
  escalation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followups_site_id ON followups(site_id);
CREATE INDEX IF NOT EXISTS idx_followups_lead_id ON followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_assigned_to ON followups(assigned_to);
CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status);
CREATE INDEX IF NOT EXISTS idx_followups_scheduled_at ON followups(scheduled_at);

-- ============================================================
-- BULK IMPORT JOBS TABLE (PostgreSQL-backed job tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS bulk_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED')),
  total_rows INTEGER DEFAULT 0,
  processed_rows INTEGER DEFAULT 0,
  failed_rows INTEGER DEFAULT 0,
  failed_details JSONB DEFAULT '[]'::jsonb,  -- array of {row_number, name, error}
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_import_jobs_site_id ON bulk_import_jobs(site_id);
CREATE INDEX IF NOT EXISTS idx_bulk_import_jobs_status ON bulk_import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_bulk_import_jobs_created_by ON bulk_import_jobs(created_by);

-- Triggers for new tables
DROP TRIGGER IF EXISTS update_call_outcomes_updated_at ON call_outcomes;
CREATE TRIGGER update_call_outcomes_updated_at
  BEFORE UPDATE ON call_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_calls_updated_at ON calls;
CREATE TRIGGER update_calls_updated_at
  BEFORE UPDATE ON calls
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_followups_updated_at ON followups;
CREATE TRIGGER update_followups_updated_at
  BEFORE UPDATE ON followups
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bulk_import_jobs_updated_at ON bulk_import_jobs;
CREATE TRIGGER update_bulk_import_jobs_updated_at
  BEFORE UPDATE ON bulk_import_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();