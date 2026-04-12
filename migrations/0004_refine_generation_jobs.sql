-- Migration number: 0004    2026-04-12
-- Refine generation_jobs for real job lifecycle:
--   - Change status CHECK to use: queued, processing, completed, failed, cancelled
--   - Add requested_params_json for normalized generation parameters
--   - Add error_code for machine-readable error classification
--   - Add queued_at and failed_at timestamps
-- Also add input_media_types to filters for compatibility checks.
--
-- SQLite does not support ALTER COLUMN or modifying CHECK constraints,
-- so we recreate generation_jobs with the updated schema.

-- Step 1: Rename old table
ALTER TABLE generation_jobs RENAME TO generation_jobs_old;

-- Step 2: Create new table with updated schema
CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    filter_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    input_asset_id TEXT NOT NULL,
    output_asset_id TEXT,
    provider_name TEXT,
    provider_job_id TEXT,
    provider_status TEXT,
    requested_params_json TEXT,
    error_code TEXT,
    error_message TEXT,
    queued_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (filter_id) REFERENCES filters(id),
    FOREIGN KEY (input_asset_id) REFERENCES assets(id),
    FOREIGN KEY (output_asset_id) REFERENCES assets(id)
);

-- Step 3: Migrate existing data (map old statuses to new ones)
INSERT INTO generation_jobs (
    id, user_id, filter_id, status, input_asset_id, output_asset_id,
    provider_name, provider_job_id, provider_status,
    error_message, started_at, completed_at, created_at, updated_at
)
SELECT
    id, user_id, filter_id,
    CASE status
        WHEN 'pending' THEN 'queued'
        WHEN 'submitted' THEN 'queued'
        ELSE status
    END,
    input_asset_id, output_asset_id,
    provider_name, provider_job_id, provider_status,
    error_message, started_at, completed_at, created_at, updated_at
FROM generation_jobs_old;

-- Step 4: Drop old table
DROP TABLE generation_jobs_old;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_jobs_user ON generation_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_filter ON generation_jobs(filter_id);

-- Step 6: Add input_media_types to filters
-- Comma-separated: "image", "video", "image,video"
-- Default to "image,video" so existing filters accept all media types.
ALTER TABLE filters ADD COLUMN input_media_types TEXT NOT NULL DEFAULT 'image,video';
