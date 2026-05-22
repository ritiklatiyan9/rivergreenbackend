-- Performance indexes — run once. All use IF NOT EXISTS so re-runs are safe.

-- leads table
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to   ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_owner_id       ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_team_id        ON leads(team_id);
CREATE INDEX IF NOT EXISTS idx_leads_site_id        ON leads(site_id);
CREATE INDEX IF NOT EXISTS idx_leads_status         ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_site_status    ON leads(site_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_owner_assigned ON leads(owner_id, assigned_to);

-- calls table
CREATE INDEX IF NOT EXISTS idx_calls_assigned_to       ON calls(assigned_to);
CREATE INDEX IF NOT EXISTS idx_calls_assigned_start    ON calls(assigned_to, call_start DESC);
CREATE INDEX IF NOT EXISTS idx_calls_lead_id           ON calls(lead_id);

-- followups table
CREATE INDEX IF NOT EXISTS idx_followups_assigned_to   ON followups(assigned_to);
CREATE INDEX IF NOT EXISTS idx_followups_lead_id       ON followups(lead_id);

-- plot_bookings table
CREATE INDEX IF NOT EXISTS idx_plot_bookings_booked_by ON plot_bookings(booked_by);
CREATE INDEX IF NOT EXISTS idx_plot_bookings_status    ON plot_bookings(status);

-- supervision_tasks table
CREATE INDEX IF NOT EXISTS idx_supervision_tasks_assigned_to ON supervision_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_supervision_tasks_status      ON supervision_tasks(status);
CREATE INDEX IF NOT EXISTS idx_supervision_tasks_due_date    ON supervision_tasks(due_date);

-- users table
CREATE INDEX IF NOT EXISTS idx_users_team_id   ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_users_site_id   ON users(site_id);
CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);
