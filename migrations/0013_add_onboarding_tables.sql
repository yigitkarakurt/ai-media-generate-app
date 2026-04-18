-- Migration: onboarding_flows + onboarding_screens
-- Supports backend-controlled onboarding for mobile clients.
-- A flow groups ordered screens; only one flow should be active at a time.

CREATE TABLE IF NOT EXISTS onboarding_flows (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS onboarding_screens (
    id                  TEXT PRIMARY KEY,
    flow_id             TEXT NOT NULL REFERENCES onboarding_flows(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    subtitle            TEXT NOT NULL DEFAULT '',
    description         TEXT NOT NULL DEFAULT '',
    media_type          TEXT NOT NULL CHECK (media_type IN ('image', 'gif', 'video')),
    media_url           TEXT NOT NULL,
    cta_text            TEXT NOT NULL DEFAULT '',
    secondary_cta_text  TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_onboarding_screens_flow ON onboarding_screens(flow_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_screens_sort ON onboarding_screens(flow_id, sort_order);

-- Seed: default onboarding flow with 3 screens
INSERT OR IGNORE INTO onboarding_flows (id, key, name, is_active, created_at, updated_at)
VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
    'default',
    'Default Onboarding',
    1,
    datetime('now'),
    datetime('now')
);

INSERT OR IGNORE INTO onboarding_screens (
    id, flow_id, title, subtitle, description,
    media_type, media_url, cta_text, secondary_cta_text,
    sort_order, is_active, created_at, updated_at
) VALUES
    (
        'ffffffff-ffff-4fff-8fff-ffffffffffff01',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
        'Create with AI',
        'Turn your imagination into reality',
        'Generate stunning images and videos from simple text prompts or your own photos.',
        'video',
        'https://cdn.example.com/onboarding/create-with-ai.mp4',
        'Next',
        NULL,
        10,
        1,
        datetime('now'),
        datetime('now')
    ),
    (
        'ffffffff-ffff-4fff-8fff-ffffffffffff02',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
        'Edit Your Photos',
        'Professional edits in seconds',
        'Apply cinematic filters, enhance portraits, or transform your photos into artwork.',
        'image',
        'https://cdn.example.com/onboarding/edit-photos.jpg',
        'Next',
        NULL,
        20,
        1,
        datetime('now'),
        datetime('now')
    ),
    (
        'ffffffff-ffff-4fff-8fff-ffffffffffff03',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
        'Go Premium',
        'Unlock the full experience',
        'Get faster generation, exclusive filters, and more credits with a premium subscription.',
        'gif',
        'https://cdn.example.com/onboarding/premium-features.gif',
        'Get Started',
        'Maybe Later',
        30,
        1,
        datetime('now'),
        datetime('now')
    );
