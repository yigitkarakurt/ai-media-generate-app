-- Migration number: 0007    2026-04-13
-- Authentication: anonymous users, device recovery, opaque session tokens

-- ─── Extend users table ───────────────────────────────────────────

ALTER TABLE users ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- ─── User devices ─────────────────────────────────────────────────
-- Tracks physical devices linked to users.
-- device_identifier is a best-effort recovery signal (e.g. Android ID,
-- identifierForVendor) — NOT a guaranteed permanent identity.

CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    device_identifier TEXT,
    installation_id TEXT,
    platform TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
    device_model TEXT,
    os_version TEXT,
    app_version TEXT,
    -- Future integrity / attestation fields (not populated yet)
    integrity_level TEXT,
    integrity_checked_at TEXT,
    risk_score REAL,
    device_attestation_status TEXT,
    -- Lifecycle
    is_active INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_identifier ON user_devices(device_identifier, platform);
CREATE INDEX IF NOT EXISTS idx_user_devices_installation ON user_devices(installation_id);

-- ─── Auth sessions ────────────────────────────────────────────────
-- Opaque bearer tokens hashed with SHA-256 before storage.
-- The raw token is returned to the client once and never stored.

CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    device_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- ─── Auth identities (for future account linking) ─────────────────
-- Prepared for Apple/Google/email linking. Not populated in this migration.

CREATE TABLE IF NOT EXISTS auth_identities (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_email TEXT,
    provider_metadata TEXT,
    linked_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider ON auth_identities(provider, provider_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
