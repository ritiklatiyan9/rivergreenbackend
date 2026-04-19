-- Migration: Add supervision_tasks table
-- Date: 2026-04-19
-- Description: Creates the supervision_tasks table for admin-to-supervisor task assignment

CREATE TABLE IF NOT EXISTS supervision_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  priority VARCHAR(20) DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE')),
  due_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_supervision_tasks_assigned_to ON supervision_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_supervision_tasks_assigned_by ON supervision_tasks(assigned_by);
CREATE INDEX IF NOT EXISTS idx_supervision_tasks_status ON supervision_tasks(status);
CREATE INDEX IF NOT EXISTS idx_supervision_tasks_site_id ON supervision_tasks(site_id);
CREATE INDEX IF NOT EXISTS idx_supervision_tasks_due_date ON supervision_tasks(due_date);
