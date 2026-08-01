-- migrate:split-statements
-- Run each statement outside a transaction so writes stay available while
-- PostgreSQL builds these indexes on a live database.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_site_created
  ON leads(site_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_site_assigned_created
  ON leads(site_id, assigned_to, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_site_owner_created
  ON leads(site_id, owner_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_site_assigned_start
  ON calls(site_id, assigned_to, call_start DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_site_start
  ON calls(site_id, call_start DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_lead_start
  ON calls(lead_id, call_start DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_site_creator_created
  ON contacts(site_id, created_by, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_plot_bookings_site_booked_date
  ON plot_bookings(site_id, booked_by, booking_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_plot_bookings_site_referred_date
  ON plot_bookings(site_id, referred_by, booking_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_site_booking_status_due
  ON payments(site_id, booking_id, status, due_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_site_creator_status_date
  ON payments(site_id, created_by, status, payment_date DESC)
  WHERE booking_id IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supervision_tasks_site_assignee_status_due
  ON supervision_tasks(site_id, assigned_to, status, due_date);
