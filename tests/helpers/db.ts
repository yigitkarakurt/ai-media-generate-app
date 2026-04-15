import { env } from "cloudflare:workers";
import type {
	BillingEventRow,
	CoinLedgerRow,
	GenerationJobRow,
	UserEntitlementRow,
} from "../../src/core/db/schema";

const RESET_TABLES = [
	"auth_sessions",
	"auth_identities",
	"user_devices",
	"device_push_tokens",
	"coin_ledger",
	"user_wallets",
	"billing_events",
	"user_entitlements",
	"billing_customers",
	"billing_products",
	"generation_jobs",
	"filter_previews",
	"filter_categories",
	"assets",
	"filters",
	"categories",
	"tags",
	"admin_settings",
	"users",
	"tasks",
] as const;

export async function resetTestDatabase(db: D1Database = env.DB) {
	for (const table of RESET_TABLES) {
		await db.prepare(`DELETE FROM ${table}`).run();
	}
}

export async function clearTestR2(bucket: R2Bucket = env.MEDIA_BUCKET) {
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ cursor });
		if (page.objects.length > 0) {
			await bucket.delete(page.objects.map((object) => object.key));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export async function getCoinBalance(userId: string, db: D1Database = env.DB) {
	const row = await db
		.prepare(
			"SELECT COALESCE(SUM(amount), 0) AS balance FROM coin_ledger WHERE user_id = ?",
		)
		.bind(userId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}

export async function getCoinLedger(userId: string, db: D1Database = env.DB) {
	const result = await db
		.prepare("SELECT * FROM coin_ledger WHERE user_id = ? ORDER BY created_at ASC")
		.bind(userId)
		.all<CoinLedgerRow>();
	return result.results;
}

export async function getBillingEvents(userId: string, db: D1Database = env.DB) {
	const result = await db
		.prepare("SELECT * FROM billing_events WHERE user_id = ? ORDER BY created_at ASC")
		.bind(userId)
		.all<BillingEventRow>();
	return result.results;
}

export function getBillingEventByRevenueCatId(
	rcEventId: string,
	db: D1Database = env.DB,
) {
	return db
		.prepare("SELECT * FROM billing_events WHERE rc_event_id = ?")
		.bind(rcEventId)
		.first<BillingEventRow>();
}

export function getUserEntitlement(userId: string, db: D1Database = env.DB) {
	return db
		.prepare("SELECT * FROM user_entitlements WHERE user_id = ?")
		.bind(userId)
		.first<UserEntitlementRow>();
}

export async function getGenerationJobs(userId: string, db: D1Database = env.DB) {
	const result = await db
		.prepare("SELECT * FROM generation_jobs WHERE user_id = ? ORDER BY created_at ASC")
		.bind(userId)
		.all<GenerationJobRow>();
	return result.results;
}

export async function getWalletBalance(userId: string, db: D1Database = env.DB) {
	const row = await db
		.prepare("SELECT balance FROM user_wallets WHERE user_id = ?")
		.bind(userId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}
