-- ============================================================
-- CALL TRACKING ENHANCEMENT MIGRATION
-- Adds columns for tracking call source (web/app) and active call sessions
-- ============================================================

-- Add call_source to track where the call was initiated from
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_source VARCHAR(20) DEFAULT 'WEB'
  CHECK (call_source IN ('WEB', 'APP', 'MANUAL'));

-- Add call_status to track active/completed calls
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_status VARCHAR(20) DEFAULT 'COMPLETED'
  CHECK (call_status IN ('RINGING', 'ACTIVE', 'COMPLETED', 'MISSED', 'FAILED'));

-- Add phone_number_dialed for quick reference
ALTER TABLE calls ADD COLUMN IF NOT EXISTS phone_number_dialed VARCHAR(20);

-- Index for active calls lookup
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(call_status);
CREATE INDEX IF NOT EXISTS idx_calls_source ON calls(call_source);

-- Composite index for agent active calls lookup
CREATE INDEX IF NOT EXISTS idx_calls_agent_status ON calls(assigned_to, call_status) WHERE call_status IN ('RINGING', 'ACTIVE');
