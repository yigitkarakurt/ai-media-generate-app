/**
 * User wallet — atomic coin balance management.
 *
 * The wallet provides concurrency-safe balance operations via D1's
 * conditional UPDATE (compare-and-swap pattern). The coin_ledger
 * remains the append-only source of truth for audit/history, while
 * user_wallets is a materialized snapshot used for atomic debits.
 *
 * Key invariant: wallet.balance == SUM(coin_ledger.amount WHERE user_id = ?)
 *
 * All functions that modify the balance MUST update both the ledger
 * AND the wallet in the same db.batch() call or sequential writes.
 */

export interface WalletBalance {
	balance: number;
	updatedAt: string;
}

/**
 * Get the current wallet balance for a user.
 * Returns 0 if no wallet exists yet (user has never had coins).
 */
export async function getWalletBalance(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare("SELECT balance FROM user_wallets WHERE user_id = ?")
		.bind(userId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}

/**
 * Initialize a wallet for a user if one doesn't exist.
 * Called lazily on first coin operation.
 */
export async function ensureWallet(
	db: D1Database,
	userId: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO user_wallets (user_id, balance, updated_at)
			 VALUES (?, 0, ?)
			 ON CONFLICT(user_id) DO NOTHING`,
		)
		.bind(userId, now)
		.run();
}

/**
 * Atomically debit coins from a user's wallet.
 *
 * Uses a conditional UPDATE that only succeeds if the balance is
 * sufficient. Returns true if the debit was applied, false if
 * insufficient funds.
 *
 * This eliminates the TOCTOU race condition where concurrent
 * requests could both read a sufficient balance before either
 * debit lands.
 *
 * IMPORTANT: The caller must also insert into coin_ledger to
 * maintain the audit trail. Use debitWalletWithLedger() for the
 * full atomic operation.
 */
export async function atomicDebit(
	db: D1Database,
	userId: string,
	amount: number,
): Promise<boolean> {
	const absAmount = Math.abs(amount);
	const now = new Date().toISOString();

	const result = await db
		.prepare(
			`UPDATE user_wallets
			 SET balance = balance - ?, updated_at = ?
			 WHERE user_id = ? AND balance >= ?`,
		)
		.bind(absAmount, now, userId, absAmount)
		.run();

	return (result.meta.changes ?? 0) > 0;
}

/**
 * Credit coins to a user's wallet (atomic upsert).
 *
 * If the wallet doesn't exist, creates it with the credited amount.
 * If it exists, adds to the current balance.
 */
export async function creditWallet(
	db: D1Database,
	userId: string,
	amount: number,
): Promise<void> {
	const absAmount = Math.abs(amount);
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO user_wallets (user_id, balance, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				balance = balance + ?,
				updated_at = ?`,
		)
		.bind(userId, absAmount, now, absAmount, now)
		.run();
}

/**
 * Build a D1PreparedStatement that credits the wallet.
 * Used in db.batch() operations (e.g., RevenueCat event processing).
 */
export function buildWalletCredit(
	db: D1Database,
	userId: string,
	amount: number,
): D1PreparedStatement {
	const absAmount = Math.abs(amount);
	const now = new Date().toISOString();
	return db
		.prepare(
			`INSERT INTO user_wallets (user_id, balance, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				balance = balance + ?,
				updated_at = ?`,
		)
		.bind(userId, absAmount, now, absAmount, now);
}

/**
 * Build a D1PreparedStatement that debits the wallet.
 * Used in db.batch() operations (e.g., RevenueCat refunds).
 *
 * NOTE: This does NOT enforce sufficient balance (it's in a batch).
 * The caller should only use this in controlled contexts like
 * refund processing where the debit is known to be valid.
 */
export function buildWalletDebit(
	db: D1Database,
	userId: string,
	amount: number,
): D1PreparedStatement {
	const absAmount = Math.abs(amount);
	const now = new Date().toISOString();
	return db
		.prepare(
			`INSERT INTO user_wallets (user_id, balance, updated_at)
			 VALUES (?, -?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				balance = balance - ?,
				updated_at = ?`,
		)
		.bind(userId, absAmount, now, absAmount, now);
}
