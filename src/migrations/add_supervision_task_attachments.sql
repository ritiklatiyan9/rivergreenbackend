-- Migration: Add attachment columns to supervision_tasks
-- Description:
--   admin_attachments  — images attached by the admin/owner when assigning the task
--                        (reference photos, instructions, blueprints, etc.)
--   proof_attachments  — images uploaded by the supervisor as proof of work
--                        (optional — only required when the supervisor wants to attach them)
-- Each entry is an object: { url, key, uploaded_at, uploaded_by }

ALTER TABLE supervision_tasks
  ADD COLUMN IF NOT EXISTS admin_attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE supervision_tasks
  ADD COLUMN IF NOT EXISTS proof_attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
