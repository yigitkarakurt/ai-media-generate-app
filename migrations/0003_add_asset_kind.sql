-- Migration number: 0003    2026-04-12
-- Add 'kind' column to assets table (input vs output distinction)

ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'input' CHECK(kind IN ('input', 'output'));
CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
