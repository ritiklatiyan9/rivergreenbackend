-- Admin Task Management
-- Tasks with due dates, priorities, auto-shift tracking for overdue items

CREATE TYPE task_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE task_status AS ENUM ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED');

CREATE TABLE IF NOT EXISTS admin_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title VARCHAR(500) NOT NULL,
  description TEXT,
  priority task_priority NOT NULL DEFAULT 'MEDIUM',
  status task_status NOT NULL DEFAULT 'TODO',

  -- Date tracking
  original_due_date DATE NOT NULL,
  current_due_date DATE NOT NULL,
  completed_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Track every time a task's due date is shifted
CREATE TABLE IF NOT EXISTS admin_task_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES admin_tasks(id) ON DELETE CASCADE,
  previous_date DATE NOT NULL,
  new_date DATE NOT NULL,
  reason VARCHAR(500),
  shifted_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_admin_tasks_site ON admin_tasks(site_id);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_creator ON admin_tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_status ON admin_tasks(site_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_due ON admin_tasks(site_id, current_due_date);
CREATE INDEX IF NOT EXISTS idx_admin_task_shifts_task ON admin_task_shifts(task_id);
