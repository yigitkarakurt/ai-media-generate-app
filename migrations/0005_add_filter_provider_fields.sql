-- Migration number: 0005    2026-04-12
-- Add provider routing and prompt configuration fields to filters.
--
--   provider_name       — which provider adapter handles this filter ("atlas", "fal", etc.)
--   prompt_template     — backend-only prompt text; the client never supplies prompts
--   default_params_json — optional JSON with provider-specific defaults (size, seed, n, …)

ALTER TABLE filters ADD COLUMN provider_name TEXT NOT NULL DEFAULT 'atlas';
ALTER TABLE filters ADD COLUMN prompt_template TEXT NOT NULL DEFAULT '';
ALTER TABLE filters ADD COLUMN default_params_json TEXT;
