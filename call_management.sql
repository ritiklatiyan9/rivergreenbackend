-- ============================================================
-- CALL OUTCOMES MASTER TABLE (Extensible by Admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS call_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,
  requires_followup BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_outcomes_site_id ON call_outcomes(site_id);
CREATE INDEX IF NOT EXISTS idx_call_outcomes_active ON call_outcomes(is_active);

-- Seed default outcomes (will use a function to avoid duplicates)
-- Run after creating the table — uses a known site or can be re-run per site

-- ============================================================
-- CALLS TABLE (Main call log)
-- ============================================================
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Call details
  call_type VARCHAR(10) NOT NULL DEFAULT 'OUTGOING'
    CHECK (call_type IN ('INCOMING', 'OUTGOING')),
  call_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  call_end TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER DEFAULT 0,

  -- Outcome
  outcome_id UUID REFERENCES call_outcomes(id) ON DELETE SET NULL,
  next_action VARCHAR(30) DEFAULT 'NONE'
    CHECK (next_action IN ('FOLLOW_UP', 'VISIT', 'CLOSE', 'NO_RESPONSE', 'NONE')),

  -- Customer response tracking (structured)
  customer_notes TEXT,
  buying_timeline VARCHAR(100),
  budget_confirmation VARCHAR(100),
  visit_preference_date DATE,
  specific_requests TEXT,
  rejection_reason TEXT,

  -- Metadata
  is_manual_log BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_site_id ON calls(site_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead_id ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_assigned_to ON calls(assigned_to);
CREATE INDEX IF NOT EXISTS idx_calls_outcome_id ON calls(outcome_id);
CREATE INDEX IF NOT EXISTS idx_calls_call_start ON calls(call_start);
CREATE INDEX IF NOT EXISTS idx_calls_next_action ON calls(next_action);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at);

-- ============================================================
-- FOLLOWUPS TABLE (Auto-created from calls or manual)
-- ============================================================
CREATE TABLE IF NOT EXISTS followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Followup details
  followup_type VARCHAR(20) NOT NULL DEFAULT 'CALL'
    CHECK (followup_type IN ('CALL', 'VISIT', 'WHATSAPP', 'MEETING')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'COMPLETED', 'MISSED', 'SNOOZED', 'ESCALATED', 'CANCELLED')),
  
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  snoozed_until TIMESTAMP WITH TIME ZONE,

  notes TEXT,
  escalated_to UUID REFERENCES users(id) ON DELETE SET NULL,
  escalation_reason TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followups_site_id ON followups(site_id);
CREATE INDEX IF NOT EXISTS idx_followups_lead_id ON followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_call_id ON followups(call_id);
CREATE INDEX IF NOT EXISTS idx_followups_assigned_to ON followups(assigned_to);
CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status);
CREATE INDEX IF NOT EXISTS idx_followups_scheduled_at ON followups(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_followups_followup_type ON followups(followup_type);

-- ============================================================
-- AUTO-UPDATE TRIGGERS
-- ============================================================
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
