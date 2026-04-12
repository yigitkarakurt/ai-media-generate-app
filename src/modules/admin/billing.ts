import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type {
	BillingEventRow,
	BillingCustomerRow,
	CoinLedgerRow,
} from "../../core/db/schema";
import { getUserEntitlement, getCoinBalance } from "../../core/billing/queries";

const billing = new Hono<AppEnv>();

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

export { billing as adminBillingRoutes };
