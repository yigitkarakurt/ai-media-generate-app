-- Migration number: 0008    2026-04-14
-- Billing improvements: generation coin cost, billing issue tracking.

-- ─── Add coin_cost to filters ─────────────────────────────────────
-- Backend-controlled cost per generation. NULL or 0 means free.

ALTER TABLE filters ADD COLUMN coin_cost INTEGER NOT NULL DEFAULT 0;

-- ─── Add billing_issue_at to user_entitlements ────────────────────
-- Tracks when a billing issue was detected (grace period signal).

ALTER TABLE user_entitlements ADD COLUMN billing_issue_at TEXT;
