-- Migration 0012    2026-04-18
-- Lightweight server-side event tracking. Append-only, best-effort.

CREATE TABLE IF NOT EXISTS tracking_events (
    id          TEXT    PRIMARY KEY NOT NULL,
    user_id     TEXT,                              -- NULL for unauthenticated events
    event_name  TEXT    NOT NULL,
    ip_address  TEXT,
    user_agent  TEXT,
    path        TEXT,
    method      TEXT,
    platform    TEXT,                              -- 'ios' | 'android' | null
    app_version TEXT,
    metadata    TEXT,                              -- compact JSON string; keep small
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Lookup by event type (admin list, future filtering)
CREATE INDEX IF NOT EXISTS idx_te_event_name ON tracking_events(event_name);
-- Lookup by user (admin drill-down)
CREATE INDEX IF NOT EXISTS idx_te_user_id    ON tracking_events(user_id);
-- Default sort: newest first
CREATE INDEX IF NOT EXISTS idx_te_created_at ON tracking_events(created_at DESC);
