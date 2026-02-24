-- ============================================================
-- MIGRATION: Plot Booking, Client Activities & Payment System
-- ============================================================

-- Add BOOKED status to map_plots
ALTER TABLE map_plots DROP CONSTRAINT IF EXISTS map_plots_status_check;
ALTER TABLE map_plots ADD CONSTRAINT map_plots_status_check
  CHECK (status IN ('AVAILABLE', 'BOOKED', 'SOLD', 'RESERVED', 'BLOCKED', 'MORTGAGE', 'REGISTRY_PENDING'));

-- If plot_bookings table already exists, update the status constraint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'plot_bookings') THEN
    ALTER TABLE plot_bookings DROP CONSTRAINT IF EXISTS plot_bookings_status_check;
    ALTER TABLE plot_bookings ADD CONSTRAINT plot_bookings_status_check
      CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'TRANSFERRED', 'PENDING_APPROVAL'));
  END IF;
END $$;

-- ============================================================
-- PLOT BOOKINGS TABLE (booking a plot for a client)
-- ============================================================
CREATE TABLE IF NOT EXISTS plot_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plot_id UUID NOT NULL REFERENCES map_plots(id) ON DELETE CASCADE,
  colony_map_id UUID NOT NULL REFERENCES colony_maps(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,

  -- Client Info
  client_name VARCHAR(255) NOT NULL,
  client_phone VARCHAR(50),
  client_email VARCHAR(255),
  client_address TEXT,

  -- Booking Details
  booking_date DATE NOT NULL DEFAULT CURRENT_DATE,
  booking_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_type VARCHAR(20) NOT NULL DEFAULT 'ONE_TIME'
    CHECK (payment_type IN ('ONE_TIME', 'INSTALLMENT')),
  installment_count INTEGER DEFAULT 1,
  installment_frequency VARCHAR(20) DEFAULT 'MONTHLY'
    CHECK (installment_frequency IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM')),

  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'TRANSFERRED', 'PENDING_APPROVAL')),

  -- Agent/User tracking
  booked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Notes
  notes TEXT,
  agreement_url TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plot_bookings_site_id ON plot_bookings(site_id);
CREATE INDEX IF NOT EXISTS idx_plot_bookings_plot_id ON plot_bookings(plot_id);
CREATE INDEX IF NOT EXISTS idx_plot_bookings_colony_map_id ON plot_bookings(colony_map_id);
CREATE INDEX IF NOT EXISTS idx_plot_bookings_lead_id ON plot_bookings(lead_id);
CREATE INDEX IF NOT EXISTS idx_plot_bookings_booked_by ON plot_bookings(booked_by);
CREATE INDEX IF NOT EXISTS idx_plot_bookings_status ON plot_bookings(status);

-- ============================================================
-- PAYMENTS TABLE (track payments for plot bookings)
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES plot_bookings(id) ON DELETE CASCADE,
  plot_id UUID NOT NULL REFERENCES map_plots(id) ON DELETE CASCADE,

  -- Payment Info
  amount DECIMAL(14,2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(30) DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI', 'CARD', 'OTHER')),
  payment_type VARCHAR(20) NOT NULL DEFAULT 'BOOKING'
    CHECK (payment_type IN ('BOOKING', 'INSTALLMENT', 'FULL_PAYMENT', 'ADVANCE', 'FINAL', 'PENALTY', 'REFUND')),

  -- Installment tracking
  installment_number INTEGER DEFAULT 0,
  due_date DATE,

  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED')),

  -- Reference
  transaction_id VARCHAR(255),
  receipt_number VARCHAR(100),
  receipt_url TEXT,
  notes TEXT,

  -- Audit
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_site_id ON payments(site_id);
CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_plot_id ON payments(plot_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_due_date ON payments(due_date);

-- ============================================================
-- CLIENT ACTIVITIES TABLE (calls, visits, meetings, plot showings)
-- ============================================================
CREATE TABLE IF NOT EXISTS client_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  plot_id UUID REFERENCES map_plots(id) ON DELETE SET NULL,
  booking_id UUID REFERENCES plot_bookings(id) ON DELETE SET NULL,

  -- Activity Details
  activity_type VARCHAR(30) NOT NULL
    CHECK (activity_type IN ('CALL_INCOMING', 'CALL_OUTGOING', 'VISIT', 'MEETING', 'PLOT_SHOWING', 'SITE_VISIT', 'NEGOTIATION', 'DOCUMENT_COLLECTION', 'FOLLOW_UP', 'OTHER')),
  title VARCHAR(255) NOT NULL,
  description TEXT,

  -- Scheduling
  scheduled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_minutes INTEGER DEFAULT 0,

  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),

  -- Outcome
  outcome TEXT,
  next_step TEXT,

  -- People
  client_name VARCHAR(255),
  client_phone VARCHAR(50),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Location
  location TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_activities_site_id ON client_activities(site_id);
CREATE INDEX IF NOT EXISTS idx_client_activities_lead_id ON client_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_activities_plot_id ON client_activities(plot_id);
CREATE INDEX IF NOT EXISTS idx_client_activities_booking_id ON client_activities(booking_id);
CREATE INDEX IF NOT EXISTS idx_client_activities_activity_type ON client_activities(activity_type);
CREATE INDEX IF NOT EXISTS idx_client_activities_status ON client_activities(status);
CREATE INDEX IF NOT EXISTS idx_client_activities_assigned_to ON client_activities(assigned_to);
CREATE INDEX IF NOT EXISTS idx_client_activities_scheduled_at ON client_activities(scheduled_at);

-- ============================================================
-- TRIGGERS for auto-update
-- ============================================================
DROP TRIGGER IF EXISTS update_plot_bookings_updated_at ON plot_bookings;
CREATE TRIGGER update_plot_bookings_updated_at
  BEFORE UPDATE ON plot_bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_payments_updated_at ON payments;
CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_client_activities_updated_at ON client_activities;
CREATE TRIGGER update_client_activities_updated_at
  BEFORE UPDATE ON client_activities
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
