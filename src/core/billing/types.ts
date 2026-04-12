/* ──────────────── RevenueCat Webhook Types ──────────────── */

export const RC_EVENT_TYPES = [
	"INITIAL_PURCHASE",
	"RENEWAL",
	"CANCELLATION",
	"UNCANCELLATION",
	"EXPIRATION",
	"NON_RENEWING_PURCHASE",
	"BILLING_ISSUE",
	"PRODUCT_CHANGE",
] as const;

export type RCEventType = (typeof RC_EVENT_TYPES)[number];

/** Subset of the RevenueCat webhook payload we actually use. */
export interface RCWebhookPayload {
	api_version: string;
	event: {
		id: string;
		type: string;
		app_user_id: string;
		product_id: string;
		entitlement_ids?: string[];
		expiration_at_ms?: number | null;
		purchased_at_ms?: number;
		store: string;
		environment: string;
	};
}

/* ──────────────── Billing Domain Types ──────────────── */

export const COIN_REASONS = [
	"purchase",
	"generation_debit",
	"refund",
	"admin_grant",
	"admin_debit",
	"bonus",
] as const;

export type CoinReason = (typeof COIN_REASONS)[number];

export const PRODUCT_TYPES = ["subscription", "coin_pack"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** Combined billing state returned to mobile clients. */
export interface BillingState {
	coins: number;
	subscription: {
		is_active: boolean;
		entitlement_id: string | null;
		product_id: string | null;
		expires_at: string | null;
	};
}

/** Result of processing a single RevenueCat webhook event. */
export interface ProcessEventResult {
	status:
		| "processed"
		| "skipped_duplicate"
		| "skipped_unknown_event"
		| "skipped_no_product"
		| "skipped_no_user";
	event_id: string | null;
}
