import type { AppBindings } from "../../bindings";
import type { BillingProductRow } from "../db/schema";
import type { RCWebhookPayload, ProcessEventResult } from "./types";
import {
	getCustomerByRCAppUserId,
	getProductByRCId,
	getEventByRCId,
	buildInsertEventStatement,
	hasCoinEntryForEvent,
} from "./queries";

/* ──────────────── Main processor ──────────────── */

/**
 * Process a single RevenueCat webhook event.
 *
 * Uses db.batch() to write the event record and its side effects atomically.
 * This prevents the "event inserted but side effect lost" partial-failure case:
 * if the batch fails, neither the event nor the side effect is persisted,
 * so RevenueCat's retry will re-deliver and we can process cleanly.
 */
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
		// Store event for audit even without user mapping
		const eventId = crypto.randomUUID();
		const now = new Date().toISOString();
		await buildInsertEventStatement(db, {
			id: eventId,
			rcEventId,
			eventType: event.type,
			rcProductId: event.product_id,
			userId: null,
			payload: JSON.stringify(payload),
			now,
		}).run();
		console.warn(
			`[billing] No customer mapping for rc_app_user_id="${event.app_user_id}" (event ${rcEventId})`,
		);
		return { status: "skipped_no_user", event_id: eventId };
	}

	const userId = customer.user_id;

	// 3. Prepare event record
	const eventId = crypto.randomUUID();
	const now = new Date().toISOString();
	const eventStmt = buildInsertEventStatement(db, {
		id: eventId,
		rcEventId,
		eventType: event.type,
		rcProductId: event.product_id,
		userId,
		payload: JSON.stringify(payload),
		now,
	});

	// 4. Resolve product mapping
	const product = await getProductByRCId(db, event.product_id);

	// 5. Route by event type — collect side-effect statements
	const sideEffects: D1PreparedStatement[] = [];
	let status: ProcessEventResult["status"] = "processed";

	switch (event.type) {
		case "INITIAL_PURCHASE":
		case "RENEWAL": {
			if (!product) {
				console.warn(`[billing] Unknown product "${event.product_id}" (event ${rcEventId})`);
				status = "skipped_no_product";
				break;
			}
			if (product.type === "subscription") {
				sideEffects.push(
					...buildSubscriptionActivation(db, userId, product, event, now),
				);
			}
			if (product.type === "coin_pack" && product.coin_amount) {
				const alreadyGranted = await hasCoinEntryForEvent(db, eventId);
				if (!alreadyGranted) {
					sideEffects.push(
						buildCoinCredit(db, userId, product.coin_amount, eventId, `Purchased ${product.name}`),
					);
				}
			}
			break;
		}

		case "NON_RENEWING_PURCHASE": {
			if (!product) {
				console.warn(`[billing] Unknown product "${event.product_id}" (event ${rcEventId})`);
				status = "skipped_no_product";
				break;
			}
			if (product.type === "coin_pack" && product.coin_amount) {
				const alreadyGranted = await hasCoinEntryForEvent(db, eventId);
				if (!alreadyGranted) {
					sideEffects.push(
						buildCoinCredit(db, userId, product.coin_amount, eventId, `Purchased ${product.name}`),
					);
				}
			}
			break;
		}

		case "CANCELLATION": {
			// CANCELLATION means user opted out of renewal (subscription) or
			// a refund/revocation occurred (could be coin_pack or subscription).
			if (product && product.type === "coin_pack" && product.coin_amount) {
				// Coin-pack cancellation = refund. Create negative compensating entry.
				const alreadyRefunded = await hasCoinEntryForEvent(db, eventId);
				if (!alreadyRefunded) {
					sideEffects.push(
						buildCoinDebit(
							db,
							userId,
							product.coin_amount,
							eventId,
							`Refund: ${product.name}`,
						),
					);
				}
			} else {
				// Subscription cancellation: mark as unsubscribed but keep active
				// until EXPIRATION fires.
				sideEffects.push(
					db.prepare(
						`UPDATE user_entitlements SET
							unsubscribed_at = ?,
							updated_at = ?
						WHERE user_id = ? AND is_active = 1`,
					).bind(now, now, userId),
				);
			}
			break;
		}

		case "UNCANCELLATION": {
			// User re-subscribed before expiration. Clear cancellation markers.
			sideEffects.push(
				db.prepare(
					`UPDATE user_entitlements SET
						unsubscribed_at = NULL,
						billing_issue_at = NULL,
						updated_at = ?
					WHERE user_id = ?`,
				).bind(now, userId),
			);
			break;
		}

		case "EXPIRATION": {
			sideEffects.push(
				buildSubscriptionExpiration(db, userId, event, now),
			);
			break;
		}

		case "BILLING_ISSUE": {
			// Record the billing issue timestamp. Do NOT revoke access yet —
			// stores typically provide a grace period.
			sideEffects.push(
				db.prepare(
					`UPDATE user_entitlements SET
						billing_issue_at = ?,
						updated_at = ?
					WHERE user_id = ? AND is_active = 1`,
				).bind(now, now, userId),
			);
			break;
		}

		case "PRODUCT_CHANGE": {
			// User switched subscription tier. Update product mapping and
			// entitlement_id if the new product implies a different one.
			if (!product) {
				console.warn(`[billing] Unknown product "${event.product_id}" for PRODUCT_CHANGE (event ${rcEventId})`);
				status = "skipped_no_product";
				break;
			}
			if (product.type === "subscription") {
				const expiresAt = event.expiration_at_ms
					? new Date(event.expiration_at_ms).toISOString()
					: null;
				sideEffects.push(
					db.prepare(
						`UPDATE user_entitlements SET
							rc_product_id = ?,
							entitlement_id = ?,
							expires_at = COALESCE(?, expires_at),
							billing_issue_at = NULL,
							updated_at = ?
						WHERE user_id = ?`,
					).bind(
						product.rc_product_id,
						product.entitlement_id ?? "premium",
						expiresAt,
						now,
						userId,
					),
				);
			}
			break;
		}

		default: {
			console.log(`[billing] Unhandled event type "${event.type}" (event ${rcEventId})`);
			status = "skipped_unknown_event";
		}
	}

	// 6. Batch write: event record + all side effects atomically
	await db.batch([eventStmt, ...sideEffects]);

	return { status, event_id: eventId };
}

/* ──────────────── Statement builders ──────────────── */

function buildSubscriptionActivation(
	db: D1Database,
	userId: string,
	product: BillingProductRow,
	event: RCWebhookPayload["event"],
	now: string,
): D1PreparedStatement[] {
	const expiresAt = event.expiration_at_ms
		? new Date(event.expiration_at_ms).toISOString()
		: null;
	const purchasedAt = event.purchased_at_ms
		? new Date(event.purchased_at_ms).toISOString()
		: null;

	const id = crypto.randomUUID();
	return [
		db.prepare(
			`INSERT INTO user_entitlements (
				id, user_id, entitlement_id, rc_product_id,
				is_active, expires_at, original_purchase_at,
				last_renewed_at, unsubscribed_at, billing_issue_at,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				entitlement_id = excluded.entitlement_id,
				rc_product_id = excluded.rc_product_id,
				is_active = 1,
				expires_at = excluded.expires_at,
				last_renewed_at = excluded.last_renewed_at,
				unsubscribed_at = NULL,
				billing_issue_at = NULL,
				updated_at = excluded.updated_at`,
		).bind(
			id,
			userId,
			product.entitlement_id ?? "premium",
			product.rc_product_id,
			expiresAt,
			event.type === "INITIAL_PURCHASE" ? purchasedAt : null,
			event.type === "RENEWAL" ? now : null,
			now,
			now,
		),
	];
}

function buildSubscriptionExpiration(
	db: D1Database,
	userId: string,
	event: RCWebhookPayload["event"],
	now: string,
): D1PreparedStatement {
	return db.prepare(
		`UPDATE user_entitlements SET
			is_active = 0,
			expires_at = ?,
			updated_at = ?
		WHERE user_id = ?`,
	).bind(
		event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : now,
		now,
		userId,
	);
}

function buildCoinCredit(
	db: D1Database,
	userId: string,
	amount: number,
	eventId: string,
	description: string,
): D1PreparedStatement {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	return db.prepare(
		`INSERT INTO coin_ledger (id, user_id, amount, reason, billing_event_id, description, created_at)
		 VALUES (?, ?, ?, 'purchase', ?, ?, ?)`,
	).bind(id, userId, Math.abs(amount), eventId, description, now);
}

function buildCoinDebit(
	db: D1Database,
	userId: string,
	amount: number,
	eventId: string,
	description: string,
): D1PreparedStatement {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	return db.prepare(
		`INSERT INTO coin_ledger (id, user_id, amount, reason, billing_event_id, description, created_at)
		 VALUES (?, ?, ?, 'refund', ?, ?, ?)`,
	).bind(id, userId, -Math.abs(amount), eventId, description, now);
}
