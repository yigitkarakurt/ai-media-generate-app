import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { AppError } from "../../shared/errors";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type {
	BillingEventRow,
	BillingCustomerRow,
	BillingProductRow,
	CoinLedgerRow,
} from "../../core/db/schema";
import {
	getUserEntitlement,
	getCoinBalance,
	insertCoinEntry,
} from "../../core/billing/queries";
import { creditWallet, buildWalletDebit, getWalletBalance } from "../../core/billing/wallet";

/* ──────────────── Validation schemas ──────────────── */

const createProductSchema = z.object({
	rc_product_id: z.string().min(1).max(255),
	type: z.enum(["subscription", "coin_pack"]),
	name: z.string().min(1).max(255),
	coin_amount: z.number().int().positive().nullable().default(null),
	entitlement_id: z.string().max(100).nullable().default(null),
	is_active: z.boolean().default(true),
});

const updateProductSchema = createProductSchema.partial();

const coinOperationSchema = z.object({
	amount: z.number().int().positive("Amount must be a positive integer"),
	description: z.string().min(1).max(500),
});

/* ──────────────── Router ──────────────── */

const billing = new Hono<AppEnv>();

/* ════════════════ User billing detail ════════════════ */

/**
 * GET /api/admin/billing/users/:id
 *
 * Full billing detail for a specific user:
 * customer mapping, entitlement, coin balance, recent ledger entries.
 */
billing.get("/users/:id", async (c) => {
	const userId = c.req.param("id");
	const db = c.env.DB;

	const [customer, entitlement, coinBalance, recentLedger] = await Promise.all([
		db
			.prepare("SELECT * FROM billing_customers WHERE user_id = ?")
			.bind(userId)
			.first<BillingCustomerRow>(),
		getUserEntitlement(db, userId),
		getCoinBalance(db, userId),
		db
			.prepare(
				"SELECT * FROM coin_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
			)
			.bind(userId)
			.all<CoinLedgerRow>(),
	]);

	return success(c, {
		user_id: userId,
		customer: customer ?? null,
		entitlement: entitlement ?? null,
		coin_balance: coinBalance,
		recent_coin_ledger: recentLedger.results,
	});
});

/* ════════════════ Coin grant / debit ════════════════ */

/**
 * POST /api/admin/billing/users/:id/coin-grant
 *
 * Manually grant coins to a user. Creates a positive ledger entry.
 */
billing.post("/users/:id/coin-grant", async (c) => {
	const userId = c.req.param("id");
	const db = c.env.DB;
	const body = await c.req.json();
	const data = coinOperationSchema.parse(body);

	// Verify user exists
	const user = await db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
	if (!user) {
		throw AppError.notFound("User");
	}

	await insertCoinEntry(db, {
		userId,
		amount: data.amount, // positive
		reason: "admin_grant",
		billingEventId: null,
		description: data.description,
	});

	// Credit wallet (keep in sync with ledger)
	await creditWallet(db, userId, data.amount);

	const balance = await getWalletBalance(db, userId);
	return success(c, { user_id: userId, granted: data.amount, balance });
});

/**
 * POST /api/admin/billing/users/:id/coin-debit
 *
 * Manually debit coins from a user. Creates a negative ledger entry.
 */
billing.post("/users/:id/coin-debit", async (c) => {
	const userId = c.req.param("id");
	const db = c.env.DB;
	const body = await c.req.json();
	const data = coinOperationSchema.parse(body);

	// Verify user exists
	const user = await db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
	if (!user) {
		throw AppError.notFound("User");
	}

	await insertCoinEntry(db, {
		userId,
		amount: -data.amount, // negative
		reason: "admin_debit",
		billingEventId: null,
		description: data.description,
	});

	// Debit wallet (keep in sync with ledger)
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO user_wallets (user_id, balance, updated_at)
			 VALUES (?, -?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				balance = balance - ?,
				updated_at = ?`,
		)
		.bind(userId, data.amount, now, data.amount, now)
		.run();

	const balance = await getWalletBalance(db, userId);
	return success(c, { user_id: userId, debited: data.amount, balance });
});

/* ════════════════ Billing events ════════════════ */

/**
 * GET /api/admin/billing/events
 *
 * Recent billing events, paginated.
 * Useful for debugging webhook delivery and processing.
 */
billing.get("/events", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				"SELECT * FROM billing_events ORDER BY created_at DESC LIMIT ? OFFSET ?",
			)
			.bind(pageSize, offset)
			.all<BillingEventRow>(),
		db
			.prepare("SELECT COUNT(*) as total FROM billing_events")
			.first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/* ════════════════ Product CRUD ════════════════ */

/**
 * GET /api/admin/billing/products
 *
 * List all billing products (including inactive).
 */
billing.get("/products", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				"SELECT * FROM billing_products ORDER BY type ASC, name ASC LIMIT ? OFFSET ?",
			)
			.bind(pageSize, offset)
			.all<BillingProductRow>(),
		db
			.prepare("SELECT COUNT(*) as total FROM billing_products")
			.first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/**
 * POST /api/admin/billing/products
 *
 * Create a new billing product.
 */
billing.post("/products", async (c) => {
	const body = await c.req.json();
	const data = createProductSchema.parse(body);
	const db = c.env.DB;

	validateProductFields(data);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO billing_products (
				id, rc_product_id, type, name, coin_amount, entitlement_id, is_active, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.rc_product_id,
			data.type,
			data.name,
			data.coin_amount,
			data.entitlement_id,
			data.is_active ? 1 : 0,
			now,
			now,
		)
		.run();

	const created = await db
		.prepare("SELECT * FROM billing_products WHERE id = ?")
		.bind(id)
		.first<BillingProductRow>();

	return success(c, created, 201);
});

/**
 * PATCH /api/admin/billing/products/:id
 *
 * Update an existing billing product.
 */
billing.patch("/products/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const data = updateProductSchema.parse(body);
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT * FROM billing_products WHERE id = ?")
		.bind(id)
		.first<BillingProductRow>();

	if (!existing) {
		throw AppError.notFound("Billing product");
	}

	// Validate type-specific fields against the final type
	const finalType = data.type ?? existing.type;
	const finalCoinAmount = data.coin_amount !== undefined ? data.coin_amount : existing.coin_amount;
	const finalEntitlementId = data.entitlement_id !== undefined ? data.entitlement_id : existing.entitlement_id;
	validateProductFields({ type: finalType, coin_amount: finalCoinAmount, entitlement_id: finalEntitlementId });

	const sets: string[] = [];
	const values: unknown[] = [];

	if (data.rc_product_id !== undefined) { sets.push("rc_product_id = ?"); values.push(data.rc_product_id); }
	if (data.type !== undefined) { sets.push("type = ?"); values.push(data.type); }
	if (data.name !== undefined) { sets.push("name = ?"); values.push(data.name); }
	if (data.coin_amount !== undefined) { sets.push("coin_amount = ?"); values.push(data.coin_amount); }
	if (data.entitlement_id !== undefined) { sets.push("entitlement_id = ?"); values.push(data.entitlement_id); }
	if (data.is_active !== undefined) { sets.push("is_active = ?"); values.push(data.is_active ? 1 : 0); }

	if (sets.length === 0) {
		return success(c, existing);
	}

	sets.push("updated_at = ?");
	values.push(new Date().toISOString());
	values.push(id);

	await db
		.prepare(`UPDATE billing_products SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await db
		.prepare("SELECT * FROM billing_products WHERE id = ?")
		.bind(id)
		.first<BillingProductRow>();

	return success(c, updated);
});

/* ──────────────── Helpers ──────────────── */

function validateProductFields(data: {
	type: string;
	coin_amount?: number | null;
	entitlement_id?: string | null;
}) {
	if (data.type === "coin_pack") {
		if (!data.coin_amount || data.coin_amount <= 0) {
			throw AppError.badRequest(
				"INVALID_COIN_AMOUNT",
				"coin_pack products must have a positive coin_amount",
			);
		}
	}
	if (data.type === "subscription") {
		if (!data.entitlement_id) {
			throw AppError.badRequest(
				"MISSING_ENTITLEMENT_ID",
				"subscription products must have an entitlement_id",
			);
		}
	}
}

export { billing as adminBillingRoutes };
