import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../../middleware/dev-auth";
import { devAuth } from "../../middleware/dev-auth";
import { success } from "../../shared/api-response";
import { AppError } from "../../shared/errors";
import {
	getUserEntitlement,
	getCoinBalance,
	getAllActiveProducts,
	upsertCustomer,
} from "../../core/billing/queries";
import type { BillingState } from "../../core/billing/types";
import type { BillingProductRow } from "../../core/db/schema";

/* ──────────────── Validation schemas ──────────────── */

const customerSchema = z.object({
	rc_app_user_id: z.string().min(1),
});

/* ──────────────── Helpers ──────────────── */

function toClientProduct(row: BillingProductRow) {
	return {
		id: row.id,
		rc_product_id: row.rc_product_id,
		type: row.type,
		name: row.name,
		coin_amount: row.coin_amount,
	};
}

/* ──────────────── Router ──────────────── */

const billing = new Hono<AuthedEnv>();

// All billing routes require authentication
billing.use("/*", devAuth);

/**
 * GET /api/mobile/billing/me
 *
 * Combined billing state: coin balance + subscription status.
 * Single call for the client to hydrate billing UI.
 */
billing.get("/me", async (c) => {
	const userId = c.get("userId");
	const db = c.env.DB;

	const [entitlement, coins] = await Promise.all([
		getUserEntitlement(db, userId),
		getCoinBalance(db, userId),
	]);

	const state: BillingState = {
		coins,
		subscription: {
			is_active: entitlement ? entitlement.is_active === 1 : false,
			entitlement_id: entitlement?.entitlement_id ?? null,
			product_id: entitlement?.rc_product_id ?? null,
			expires_at: entitlement?.expires_at ?? null,
		},
	};

	return success(c, state);
});

/**
 * GET /api/mobile/billing/coins
 *
 * Current coin balance for the authenticated user.
 */
billing.get("/coins", async (c) => {
	const userId = c.get("userId");
	const balance = await getCoinBalance(c.env.DB, userId);
	return success(c, { balance });
});

/**
 * GET /api/mobile/billing/entitlements
 *
 * Current subscription/entitlement state.
 */
billing.get("/entitlements", async (c) => {
	const userId = c.get("userId");
	const entitlement = await getUserEntitlement(c.env.DB, userId);

	return success(c, {
		is_active: entitlement ? entitlement.is_active === 1 : false,
		entitlement_id: entitlement?.entitlement_id ?? null,
		product_id: entitlement?.rc_product_id ?? null,
		expires_at: entitlement?.expires_at ?? null,
		unsubscribed_at: entitlement?.unsubscribed_at ?? null,
	});
});

/**
 * GET /api/mobile/billing/products
 *
 * List available billing products (subscriptions and coin packs).
 * Used by the client to display purchase options.
 */
billing.get("/products", async (c) => {
	const products = await getAllActiveProducts(c.env.DB);
	return success(c, products.map(toClientProduct));
});

/**
 * POST /api/mobile/billing/customer
 *
 * Register or update the RevenueCat customer mapping.
 * Called by the mobile client after RevenueCat SDK initialization
 * to link the app user to their RevenueCat identity.
 */
billing.post("/customer", async (c) => {
	const userId = c.get("userId");
	const body = await c.req.json();
	const data = customerSchema.parse(body);

	await upsertCustomer(c.env.DB, userId, data.rc_app_user_id);

	return success(c, { user_id: userId, rc_app_user_id: data.rc_app_user_id });
});

export { billing as mobileBillingRoutes };
