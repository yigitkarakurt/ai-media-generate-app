-- Migration 0006    2026-04-13
-- Billing foundation: RevenueCat integration with subscriptions and coin packs.

-- ──────────────── billing_customers ────────────────
-- Links app user to RevenueCat identity. One row per user.

CREATE TABLE IF NOT EXISTS billing_customers (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    rc_app_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_customers_user ON billing_customers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_customers_rc ON billing_customers(rc_app_user_id);

-- ──────────────── billing_products ────────────────
-- Maps RevenueCat product IDs to backend behaviour (entitlement or coin grant).
-- Seeded via admin API or direct insert.

CREATE TABLE IF NOT EXISTS billing_products (
    id TEXT PRIMARY KEY NOT NULL,
    rc_product_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('subscription', 'coin_pack')),
    name TEXT NOT NULL DEFAULT '',
    coin_amount INTEGER,          -- only for coin_pack products
    entitlement_id TEXT,          -- only for subscription products (e.g. 'premium')
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_products_rc ON billing_products(rc_product_id);

-- ──────────────── user_entitlements ────────────────
-- Current subscription/premium state per user.
-- One row per user, upserted on subscription lifecycle events.

CREATE TABLE IF NOT EXISTS user_entitlements (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    entitlement_id TEXT NOT NULL,
    rc_product_id TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    original_purchase_at TEXT,
    last_renewed_at TEXT,
    unsubscribed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_entitlements_user ON user_entitlements(user_id);

-- ──────────────── billing_events ────────────────
-- Processed webhook events for idempotency and auditing.
-- Must be created before coin_ledger (FK dependency).

CREATE TABLE IF NOT EXISTS billing_events (
    id TEXT PRIMARY KEY NOT NULL,
    rc_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    rc_product_id TEXT,
    user_id TEXT,
    payload TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_rc ON billing_events(rc_event_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id);

-- ──────────────── coin_ledger ────────────────
-- Append-only credit/debit log. Balance = SUM(amount) WHERE user_id = ?.
-- amount is signed: positive for credits, negative for debits.

CREATE TABLE IF NOT EXISTS coin_ledger (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('purchase', 'generation_debit', 'refund', 'admin_grant', 'admin_debit', 'bonus')),
    billing_event_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (billing_event_id) REFERENCES billing_events(id)
);

CREATE INDEX IF NOT EXISTS idx_coin_ledger_user ON coin_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_event ON coin_ledger(billing_event_id);

-- ──────────────── Example product seed (not auto-inserted) ────────────────
-- INSERT INTO billing_products (id, rc_product_id, type, name, coin_amount, entitlement_id)
-- VALUES
--   ('prod-sub-monthly',  'com.app.premium_monthly',  'subscription', 'Premium Monthly',  NULL, 'premium'),
--   ('prod-sub-yearly',   'com.app.premium_yearly',   'subscription', 'Premium Yearly',   NULL, 'premium'),
--   ('prod-coins-100',    'com.app.coins_100',        'coin_pack',    '100 Coins',        100,  NULL),
--   ('prod-coins-500',    'com.app.coins_500',        'coin_pack',    '500 Coins',        500,  NULL),
--   ('prod-coins-1000',   'com.app.coins_1000',       'coin_pack',    '1000 Coins',       1000, NULL);
