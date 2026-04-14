import type {
	BillingCustomerRow,
	BillingProductRow,
	UserEntitlementRow,
	BillingEventRow,
} from "../db/schema";
import type { CoinReason } from "./types";

/* ──────────────── Customer lookups ──────────────── */

export async function getCustomerByUserId(
	db: D1Database,
	userId: string,
): Promise<BillingCustomerRow | null> {
	return db
		.prepare("SELECT * FROM billing_customers WHERE user_id = ?")
		.bind(userId)
		.first<BillingCustomerRow>();
}

export async function getCustomerByRCAppUserId(
	db: D1Database,
	rcAppUserId: string,
): Promise<BillingCustomerRow | null> {
	return db
		.prepare("SELECT * FROM billing_customers WHERE rc_app_user_id = ?")
		.bind(rcAppUserId)
		.first<BillingCustomerRow>();
}

export async function upsertCustomer(
	db: D1Database,
	userId: string,
	rcAppUserId: string,
): Promise<void> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO billing_customers (id, user_id, rc_app_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				rc_app_user_id = excluded.rc_app_user_id,
				updated_at = excluded.updated_at`,
		)
		.bind(id, userId, rcAppUserId, now, now)
		.run();
}

/* ──────────────── Product lookups ──────────────── */

export async function getProductByRCId(
	db: D1Database,
	rcProductId: string,
): Promise<BillingProductRow | null> {
	return db
		.prepare("SELECT * FROM billing_products WHERE rc_product_id = ? AND is_active = 1")
		.bind(rcProductId)
		.first<BillingProductRow>();
}

export async function getAllActiveProducts(
	db: D1Database,
): Promise<BillingProductRow[]> {
	const result = await db
		.prepare("SELECT * FROM billing_products WHERE is_active = 1 ORDER BY type ASC, name ASC")
		.all<BillingProductRow>();
	return result.results;
}

/* ──────────────── Entitlement queries ──────────────── */

export async function getUserEntitlement(
	db: D1Database,
	userId: string,
): Promise<UserEntitlementRow | null> {
	return db
		.prepare("SELECT * FROM user_entitlements WHERE user_id = ?")
		.bind(userId)
		.first<UserEntitlementRow>();
}

export async function upsertEntitlement(
	db: D1Database,
	params: {
		userId: string;
		entitlementId: string;
		rcProductId: string;
		isActive: boolean;
		expiresAt: string | null;
		originalPurchaseAt: string | null;
		lastRenewedAt: string | null;
		unsubscribedAt: string | null;
	},
): Promise<void> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO user_entitlements (
				id, user_id, entitlement_id, rc_product_id,
				is_active, expires_at, original_purchase_at,
				last_renewed_at, unsubscribed_at,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				entitlement_id = excluded.entitlement_id,
				rc_product_id = excluded.rc_product_id,
				is_active = excluded.is_active,
				expires_at = excluded.expires_at,
				last_renewed_at = excluded.last_renewed_at,
				unsubscribed_at = excluded.unsubscribed_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			id,
			params.userId,
			params.entitlementId,
			params.rcProductId,
			params.isActive ? 1 : 0,
			params.expiresAt,
			params.originalPurchaseAt,
			params.lastRenewedAt,
			params.unsubscribedAt,
			now,
			now,
		)
		.run();
}

/* ──────────────── Coin queries ──────────────── */

export async function getCoinBalance(
	db: D1Database,
	userId: string,
): Promise<number> {
	const result = await db
		.prepare("SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger WHERE user_id = ?")
		.bind(userId)
		.first<{ balance: number }>();
	return result?.balance ?? 0;
}

export async function insertCoinEntry(
	db: D1Database,
	params: {
		userId: string;
		amount: number;
		reason: string;
		billingEventId: string | null;
		description: string;
	},
): Promise<void> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO coin_ledger (id, user_id, amount, reason, billing_event_id, description, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			params.userId,
			params.amount,
			params.reason,
			params.billingEventId,
			params.description,
			now,
		)
		.run();
}

/**
 * Check if a coin ledger entry already exists for a given RevenueCat event ID.
 *
 * Used as a secondary idempotency guard in webhook processing.
 * Joins through billing_events to match on the stable RC event ID,
 * since coin_ledger.billing_event_id references billing_events.id (internal UUID).
 */
export async function hasCoinEntryForRCEvent(
	db: D1Database,
	rcEventId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT cl.id FROM coin_ledger cl
			 JOIN billing_events be ON cl.billing_event_id = be.id
			 WHERE be.rc_event_id = ?
			 LIMIT 1`,
		)
		.bind(rcEventId)
		.first<{ id: string }>();
	return row !== null;
}

/** @deprecated Use hasCoinEntryForRCEvent instead */
export const hasCoinEntryForEvent = hasCoinEntryForRCEvent;

/* ──────────────── Compensating / debit coin entries ──────────────── */

/**
 * Create a compensating (refund) coin entry. Always positive amount.
 */
export async function createCompensatingCoinEntry(
	db: D1Database,
	params: {
		userId: string;
		amount: number;
		reason: CoinReason;
		billingEventId: string | null;
		description: string;
	},
): Promise<void> {
	const absAmount = Math.abs(params.amount);
	await insertCoinEntry(db, { ...params, amount: absAmount });
}

/**
 * Create a debit (negative) coin entry for generation usage.
 * Returns the ledger entry id.
 */
export async function createGenerationDebit(
	db: D1Database,
	userId: string,
	amount: number,
	jobId: string,
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO coin_ledger (id, user_id, amount, reason, billing_event_id, description, created_at)
			 VALUES (?, ?, ?, 'generation_debit', NULL, ?, ?)`,
		)
		.bind(id, userId, -Math.abs(amount), `Generation job ${jobId}`, now)
		.run();
	return id;
}

/**
 * Refund a failed generation. Positive compensating entry.
 */
export async function refundGenerationDebit(
	db: D1Database,
	userId: string,
	amount: number,
	jobId: string,
): Promise<void> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO coin_ledger (id, user_id, amount, reason, billing_event_id, description, created_at)
			 VALUES (?, ?, ?, 'refund', NULL, ?, ?)`,
		)
		.bind(id, userId, Math.abs(amount), `Refund for failed generation ${jobId}`, now)
		.run();
}

/* ──────────────── Event idempotency ──────────────── */

export async function getEventByRCId(
	db: D1Database,
	rcEventId: string,
): Promise<BillingEventRow | null> {
	return db
		.prepare("SELECT * FROM billing_events WHERE rc_event_id = ?")
		.bind(rcEventId)
		.first<BillingEventRow>();
}

export function buildInsertEventStatement(
	db: D1Database,
	params: {
		id: string;
		rcEventId: string;
		eventType: string;
		rcProductId: string | null;
		userId: string | null;
		payload: string;
		now: string;
	},
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO billing_events (id, rc_event_id, event_type, rc_product_id, user_id, payload, processed_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			params.id,
			params.rcEventId,
			params.eventType,
			params.rcProductId,
			params.userId,
			params.payload,
			params.now,
			params.now,
		);
}

export async function insertEvent(
	db: D1Database,
	params: {
		rcEventId: string;
		eventType: string;
		rcProductId: string | null;
		userId: string | null;
		payload: string;
	},
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await buildInsertEventStatement(db, {
		id,
		rcEventId: params.rcEventId,
		eventType: params.eventType,
		rcProductId: params.rcProductId,
		userId: params.userId,
		payload: params.payload,
		now,
	}).run();
	return id;
}
