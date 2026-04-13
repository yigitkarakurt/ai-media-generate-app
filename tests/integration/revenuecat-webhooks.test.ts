import { beforeEach, describe, expect, it } from "vitest";
import type { ProcessEventResult } from "../../src/core/billing/types";
import {
	postRevenueCatWebhook,
	successJson,
} from "../helpers/app";
import {
	getBillingEventByRevenueCatId,
	getBillingEvents,
	getCoinBalance,
	getCoinLedger,
	getUserEntitlement,
	resetTestDatabase,
} from "../helpers/db";
import {
	insertBillingCustomer,
	insertBillingProduct,
	insertUser,
	makeRevenueCatEvent,
} from "../helpers/factories";

describe("RevenueCat webhook integration", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("grants coin packs once and skips duplicate webhook delivery", async () => {
		const user = await insertUser();
		const customer = await insertBillingCustomer(user.id, "rc-user-coinpack");
		await insertBillingProduct({
			rc_product_id: "com.app.coins_100",
			type: "coin_pack",
			name: "100 Coins",
			coin_amount: 100,
		});

		const payload = makeRevenueCatEvent({
			id: "event-coinpack-1",
			type: "NON_RENEWING_PURCHASE",
			app_user_id: customer.rc_app_user_id,
			product_id: "com.app.coins_100",
		});

		const firstResponse = await postRevenueCatWebhook(payload);
		const firstBody = await successJson<ProcessEventResult>(firstResponse);

		expect(firstResponse.status).toBe(200);
		expect(firstBody.data.status).toBe("processed");
		expect(await getCoinBalance(user.id)).toBe(100);

		const firstLedger = await getCoinLedger(user.id);
		expect(firstLedger).toHaveLength(1);
		expect(firstLedger[0]).toMatchObject({
			amount: 100,
			reason: "purchase",
		});

		const firstEvents = await getBillingEvents(user.id);
		expect(firstEvents).toHaveLength(1);
		expect(firstEvents[0].rc_event_id).toBe("event-coinpack-1");

		const replayResponse = await postRevenueCatWebhook(payload);
		const replayBody = await successJson<ProcessEventResult>(replayResponse);

		expect(replayResponse.status).toBe(200);
		expect(replayBody.data.status).toBe("skipped_duplicate");
		expect(await getCoinBalance(user.id)).toBe(100);
		expect(await getCoinLedger(user.id)).toHaveLength(1);
		expect(await getBillingEvents(user.id)).toHaveLength(1);
	});

	it("records unknown product events without granting coins or crashing", async () => {
		const user = await insertUser();
		const customer = await insertBillingCustomer(user.id, "rc-user-unknown-product");
		const payload = makeRevenueCatEvent({
			id: "event-unknown-product",
			type: "NON_RENEWING_PURCHASE",
			app_user_id: customer.rc_app_user_id,
			product_id: "com.app.unknown_pack",
		});

		const response = await postRevenueCatWebhook(payload);
		const body = await successJson<ProcessEventResult>(response);

		expect(response.status).toBe(200);
		expect(body.data.status).toBe("skipped_no_product");
		expect(await getCoinBalance(user.id)).toBe(0);
		expect(await getCoinLedger(user.id)).toEqual([]);

		const event = await getBillingEventByRevenueCatId("event-unknown-product");
		expect(event).toMatchObject({
			rc_event_id: "event-unknown-product",
			user_id: user.id,
			rc_product_id: "com.app.unknown_pack",
		});
	});

	it("normalizes the core subscription lifecycle into entitlement state", async () => {
		const user = await insertUser();
		const customer = await insertBillingCustomer(user.id, "rc-user-subscription");
		await insertBillingProduct({
			rc_product_id: "com.app.premium_monthly",
			type: "subscription",
			name: "Premium Monthly",
			entitlement_id: "premium",
		});
		await insertBillingProduct({
			rc_product_id: "com.app.premium_yearly",
			type: "subscription",
			name: "Premium Yearly",
			entitlement_id: "premium",
		});

		const initial = await postRevenueCatWebhook(
			makeRevenueCatEvent({
				id: "event-sub-initial",
				type: "INITIAL_PURCHASE",
				app_user_id: customer.rc_app_user_id,
				product_id: "com.app.premium_monthly",
			}),
		);
		expect(initial.status).toBe(200);
		expect(await getUserEntitlement(user.id)).toMatchObject({
			is_active: 1,
			entitlement_id: "premium",
			rc_product_id: "com.app.premium_monthly",
			unsubscribed_at: null,
			billing_issue_at: null,
		});

		const cancellation = await postRevenueCatWebhook(
			makeRevenueCatEvent({
				id: "event-sub-cancel",
				type: "CANCELLATION",
				app_user_id: customer.rc_app_user_id,
				product_id: "com.app.premium_monthly",
			}),
		);
		expect(cancellation.status).toBe(200);
		const cancelled = await getUserEntitlement(user.id);
		expect(cancelled?.is_active).toBe(1);
		expect(cancelled?.unsubscribed_at).toEqual(expect.any(String));

		const uncancellation = await postRevenueCatWebhook(
			makeRevenueCatEvent({
				id: "event-sub-uncancel",
				type: "UNCANCELLATION",
				app_user_id: customer.rc_app_user_id,
				product_id: "com.app.premium_monthly",
			}),
		);
		expect(uncancellation.status).toBe(200);
		expect(await getUserEntitlement(user.id)).toMatchObject({
			is_active: 1,
			unsubscribed_at: null,
			billing_issue_at: null,
		});

		const productChange = await postRevenueCatWebhook(
			makeRevenueCatEvent({
				id: "event-sub-product-change",
				type: "PRODUCT_CHANGE",
				app_user_id: customer.rc_app_user_id,
				product_id: "com.app.premium_yearly",
			}),
		);
		expect(productChange.status).toBe(200);
		expect(await getUserEntitlement(user.id)).toMatchObject({
			is_active: 1,
			entitlement_id: "premium",
			rc_product_id: "com.app.premium_yearly",
		});

		const expiration = await postRevenueCatWebhook(
			makeRevenueCatEvent({
				id: "event-sub-expiration",
				type: "EXPIRATION",
				app_user_id: customer.rc_app_user_id,
				product_id: "com.app.premium_yearly",
				expiration_at_ms: Date.now() - 1000,
			}),
		);
		expect(expiration.status).toBe(200);
		expect(await getUserEntitlement(user.id)).toMatchObject({
			is_active: 0,
			entitlement_id: "premium",
			rc_product_id: "com.app.premium_yearly",
		});
	});
});
