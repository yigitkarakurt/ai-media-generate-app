-- Migration number: 0009    2026-04-14
-- Add user_wallets table for atomic coin balance management.
-- This provides concurrency-safe balance operations that the
-- append-only coin_ledger alone cannot guarantee.

-- ─── user_wallets ─────────────────────────────────────────
-- Cached current coin balance per user. Updated atomically
-- alongside coin_ledger entries to prevent concurrent overspend.
-- The coin_ledger remains the source of truth for audit/history.

CREATE TABLE IF NOT EXISTS user_wallets (
    user_id TEXT PRIMARY KEY NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Backfill existing balances from coin_ledger
INSERT INTO user_wallets (user_id, balance, updated_at)
SELECT user_id, COALESCE(SUM(amount), 0), datetime('now')
FROM coin_ledger
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET
    balance = excluded.balance,
    updated_at = excluded.updated_at;
