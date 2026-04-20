-- ────────────────────────────────────────────────────────────────────────────
-- Lead import batches
-- Link each lead back to the bulk_import_jobs row that created it so agents
-- can filter their Fresh Leads view by import batch, and add an optional
-- editable label on the job (e.g. "Import 1", "April list") so the user
-- can rename a batch from the UI.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS leads
  ADD COLUMN IF NOT EXISTS import_job_id UUID REFERENCES bulk_import_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_import_job_id ON leads(import_job_id);

ALTER TABLE IF EXISTS bulk_import_jobs
  ADD COLUMN IF NOT EXISTS label TEXT;
