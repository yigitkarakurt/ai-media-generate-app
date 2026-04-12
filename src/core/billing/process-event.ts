import type { AppBindings } from "../../bindings";
import type { BillingProductRow } from "../db/schema";
import type { RCWebhookPayload, ProcessEventResult } from "./types";
import {
	getCustomerByRCAppUserId,
	getProductByRCId,
	getEventByRCId,
	insertEvent,
	upsertEntitlement,
	insertCoinEntry,
	hasCoinEntryForEvent,
} from "./queries";

/* ──────────────── Main processor ──────────────── */

export async function processRevenueCatEvent(
	payload: RCWebhookPayload,
	env: AppBindings,
): Promise<ProcessEventResult> {
	const db = env.DB;
	const event = payload.event;
	const rcEventId = event.id;

	// 1. Idempotency check — skip if we already processed this event
	const existing = await getEventByRCId(db, rcEventId);
	if (existing) {
		return { status: "skipped_duplicate", event_id: existing.id };
	}

	// 2. Resolve user from rc_app_user_id
	const customer = await getCustomerByRCAppUserId(db, event.app_user_id);
	if (!customer) {
		// Store event for audit but cannot process without user mapping
		const eventId = await insertEvent(db, {
			rcEventId,
			eventType: event.type,
			rcProductId: event.product_id,
			userId: null,
			payload: JSON.stringify(payload),
		});
		console.warn(
			`[billing] No customer mapping for rc_app_user_id="${event.app_user_id}" (event ${rcEventId})`,
		);
		return { status: "skipped_no_user", event_id: eventId };
	}

	const userId = customer.user_id;

	// 3. Store event record (idempotency marker)
	const eventId = await insertEvent(db, {
		rcEventId,
		eventType: event.type,
		rcProductId: event.product_id,
		userId,
		payload: JSON.stringify(payload),
	});

	// 4. Resolve product mapping
	const product = await getProductByRCId(db, event.product_id);

	// 5. Route by event type
	switch (event.type) {
		case "INITIAL_PURCHASE":
		case "RENEWAL": {
			if (!product) {
				console.warn(`[billing] Unknown product "${event.product_id}" (event ${rcEventId})`);
				return { status: "skipped_no_product", event_id: eventId };
			}
			if (product.type === "subscription") {
				await handleSubscriptionActivation(db, userId, product, event);
			}
			if (product.type === "coin_pack" && product.coin_amount) {
				// INITIAL_PURCHASE can be a one-time coin pack in some RevenueCat flows
				await handleCoinPurchase(db, userId, product, eventId);
			}
			break;
		}

		case "NON_RENEWING_PURCHASE": {
			if (!product) {
				console.warn(`[billing] Unknown product "${event.product_id}" (event ${rcEventId})`);
				return { status: "skipped_no_product", event_id: eventId };
			}
			if (product.type === "coin_pack" && product.coin_amount) {
				await handleCoinPurchase(db, userId, product, eventId);
			}
			break;
		}

		case "EXPIRATION": {
			await handleSubscriptionExpiration(db, userId, event);
			break;
		}

		case "CANCELLATION": {
			await handleSubscriptionCancellation(db, userId);
			break;
		}

		default: {
			console.log(`[billing] Unhandled event type "${event.type}" (event ${rcEventId})`);
			return { status: "skipped_unknown_event", event_id: eventId };
		}
	}

	return { status: "processed", event_id: eventId };
}

/* ──────────────── Event handlers ──────────────── */

async function handleSubscriptionActivation(
	db: D1Database,
	userId: string,
	product: BillingProductRow,
	event: RCWebhookPayload["event"],
): Promise<void> {
	const expiresAt = event.expiration_at_ms
		? new Date(event.expiration_at_ms).toISOString()
		: null;
	const purchasedAt = event.purchased_at_ms
		? new Date(event.purchased_at_ms).toISOString()
		: null;
	const now = new Date().toISOString();

	await upsertEntitlement(db, {
		userId,
		entitlementId: product.entitlement_id ?? "premium",
		rcProductId: product.rc_product_id,
		isActive: true,
		expiresAt,
		originalPurchaseAt: event.type === "INITIAL_PURCHASE" ? purchasedAt : null,
		lastRenewedAt: event.type === "RENEWAL" ? now : null,
		unsubscribedAt: null,
	});
}

async function handleCoinPurchase(
	db: D1Database,
	userId: string,
	product: BillingProductRow,
	eventId: string,
): Promise<void> {
	// Belt-and-suspenders: check if a coin entry already references this event
	const alreadyGranted = await hasCoinEntryForEvent(db, eventId);
	if (alreadyGranted) {
		console.warn(`[billing] Coin entry already exists for event ${eventId}, skipping`);
		return;
	}

	await insertCoinEntry(db, {
		userId,
		amount: product.coin_amount!,
		reason: "purchase",
		billingEventId: eventId,
		description: `Purchased ${product.name}`,
	});
}

async function handleSubscriptionExpiration(
	db: D1Database,
	userId: string,
	event: RCWebhookPayload["event"],
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE user_entitlements SET
				is_active = 0,
				expires_at = ?,
				updated_at = ?
			WHERE user_id = ?`,
		)
		.bind(
			event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : now,
			now,
			userId,
		)
		.run();
}

async function handleSubscriptionCancellation(
	db: D1Database,
	userId: string,
): Promise<void> {
	// CANCELLATION means user opted out of renewal.
	// The subscription stays active until its expiry date.
	// EXPIRATION event will flip is_active to 0.
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE user_entitlements SET
				unsubscribed_at = ?,
				updated_at = ?
			WHERE user_id = ? AND is_active = 1`,
		)
		.bind(now, now, userId)
		.run();
}
