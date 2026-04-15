import { env } from "cloudflare:workers";
import type { RCWebhookPayload } from "../../src/core/billing/types";
import type {
	AssetRow,
	BillingProductRow,
	FilterRow,
	TagRow,
	UserRow,
} from "../../src/core/db/schema";
import { createSession } from "../../src/core/auth/sessions";

type ProductType = "subscription" | "coin_pack";
type AssetType = "image" | "video";

function nowIso() {
	return new Date().toISOString();
}

function id(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

export async function insertUser(
	overrides: Partial<UserRow> = {},
	db: D1Database = env.DB,
) {
	const userId = overrides.id ?? crypto.randomUUID();
	const now = nowIso();
	const user = {
		id: userId,
		email: overrides.email ?? `user-${userId}@example.test`,
		display_name: overrides.display_name ?? "Test User",
		avatar_url: overrides.avatar_url ?? null,
		auth_provider: overrides.auth_provider ?? "test",
		auth_provider_id: overrides.auth_provider_id ?? userId,
		role: overrides.role ?? "user",
		is_anonymous: overrides.is_anonymous ?? 0,
		status: overrides.status ?? "active",
		created_at: overrides.created_at ?? now,
		updated_at: overrides.updated_at ?? now,
	} satisfies UserRow;

	await db
		.prepare(
			`INSERT INTO users (
				id, email, display_name, avatar_url, auth_provider, auth_provider_id,
				role, is_anonymous, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			user.id,
			user.email,
			user.display_name,
			user.avatar_url,
			user.auth_provider,
			user.auth_provider_id,
			user.role,
			user.is_anonymous,
			user.status,
			user.created_at,
			user.updated_at,
		)
		.run();

	return user;
}

export async function createAuthenticatedUser(db: D1Database = env.DB) {
	const user = await insertUser({}, db);
	const session = await createSession(db, user.id, null);
	return { user, token: session.rawToken, sessionId: session.sessionId };
}

export async function insertBillingCustomer(
	userId: string,
	rcAppUserId = `rc-${userId}`,
	db: D1Database = env.DB,
) {
	const now = nowIso();
	const row = {
		id: crypto.randomUUID(),
		user_id: userId,
		rc_app_user_id: rcAppUserId,
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO billing_customers (id, user_id, rc_app_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(row.id, row.user_id, row.rc_app_user_id, row.created_at, row.updated_at)
		.run();

	return row;
}

export async function insertBillingProduct(
	overrides: Partial<BillingProductRow> & {
		rc_product_id: string;
		type: ProductType;
	},
	db: D1Database = env.DB,
) {
	const now = nowIso();
	const product = {
		id: overrides.id ?? crypto.randomUUID(),
		rc_product_id: overrides.rc_product_id,
		type: overrides.type,
		name: overrides.name ?? overrides.rc_product_id,
		coin_amount:
			overrides.coin_amount ??
			(overrides.type === "coin_pack" ? 100 : null),
		entitlement_id:
			overrides.entitlement_id ??
			(overrides.type === "subscription" ? "premium" : null),
		is_active: overrides.is_active ?? 1,
		created_at: overrides.created_at ?? now,
		updated_at: overrides.updated_at ?? now,
	} satisfies BillingProductRow;

	await db
		.prepare(
			`INSERT INTO billing_products (
				id, rc_product_id, type, name, coin_amount, entitlement_id,
				is_active, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			product.id,
			product.rc_product_id,
			product.type,
			product.name,
			product.coin_amount,
			product.entitlement_id,
			product.is_active,
			product.created_at,
			product.updated_at,
		)
		.run();

	return product;
}

export async function insertCoinEntry(
	userId: string,
	amount: number,
	reason: "purchase" | "generation_debit" | "refund" | "admin_grant" | "admin_debit" | "bonus" = "admin_grant",
	db: D1Database = env.DB,
) {
	const row = {
		id: crypto.randomUUID(),
		user_id: userId,
		amount,
		reason,
		billing_event_id: null,
		description: `Test ${reason}`,
		created_at: nowIso(),
	};

	await db
		.prepare(
			`INSERT INTO coin_ledger (
				id, user_id, amount, reason, billing_event_id, description, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.amount,
			row.reason,
			row.billing_event_id,
			row.description,
			row.created_at,
		)
		.run();

	// Keep user_wallets in sync with coin_ledger
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO user_wallets (user_id, balance, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				balance = balance + ?,
				updated_at = ?`,
		)
		.bind(userId, amount, now, amount, now)
		.run();

	return row;
}

export async function insertAsset(
	userId: string,
	overrides: Partial<AssetRow> = {},
	db: D1Database = env.DB,
) {
	const assetId = overrides.id ?? crypto.randomUUID();
	const now = nowIso();
	const type = (overrides.type ?? "image") as AssetType;
	const asset = {
		id: assetId,
		user_id: userId,
		kind: overrides.kind ?? "input",
		type,
		status: overrides.status ?? "uploaded",
		storage_key:
			overrides.storage_key ?? `input/${userId}/${assetId}/image.png`,
		original_filename: overrides.original_filename ?? "image.png",
		mime_type:
			overrides.mime_type ?? (type === "image" ? "image/png" : "video/mp4"),
		file_size_bytes: overrides.file_size_bytes ?? 1024,
		width: overrides.width ?? (type === "image" ? 512 : null),
		height: overrides.height ?? (type === "image" ? 512 : null),
		duration_seconds: overrides.duration_seconds ?? null,
		metadata: overrides.metadata ?? null,
		created_at: overrides.created_at ?? now,
		updated_at: overrides.updated_at ?? now,
	} satisfies AssetRow;

	await db
		.prepare(
			`INSERT INTO assets (
				id, user_id, kind, type, status, storage_key, original_filename,
				mime_type, file_size_bytes, width, height, duration_seconds,
				metadata, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			asset.id,
			asset.user_id,
			asset.kind,
			asset.type,
			asset.status,
			asset.storage_key,
			asset.original_filename,
			asset.mime_type,
			asset.file_size_bytes,
			asset.width,
			asset.height,
			asset.duration_seconds,
			asset.metadata,
			asset.created_at,
			asset.updated_at,
		)
		.run();

	return asset;
}

export async function insertFilter(
	overrides: Partial<FilterRow> = {},
	db: D1Database = env.DB,
) {
	const filterId = overrides.id ?? crypto.randomUUID();
	const now = nowIso();
	const filter = {
		id: filterId,
		name: overrides.name ?? "Test Filter",
		slug: overrides.slug ?? `test-filter-${filterId}`,
		description: overrides.description ?? "Test filter",
		thumbnail_url: overrides.thumbnail_url ?? "https://example.test/thumb.png",
		category: overrides.category ?? "test",
		provider_model_id: overrides.provider_model_id ?? "atlas-test-model",
		config: overrides.config ?? null,
		input_media_types: overrides.input_media_types ?? "image",
		provider_name: overrides.provider_name ?? "atlas",
		prompt_template: overrides.prompt_template ?? "Generate a test image",
		default_params_json: overrides.default_params_json ?? null,
		is_active: overrides.is_active ?? 1,
		coin_cost: overrides.coin_cost ?? 0,
		tag_id: overrides.tag_id ?? null,
		preview_image_url: overrides.preview_image_url ?? "https://example.test/preview.png",
		model_key: overrides.model_key ?? overrides.provider_model_id ?? "atlas-test-model",
		operation_type: overrides.operation_type ?? "image_to_image",
		is_featured: overrides.is_featured ?? 0,
		sort_order: overrides.sort_order ?? 0,
		created_at: overrides.created_at ?? now,
		updated_at: overrides.updated_at ?? now,
	} satisfies FilterRow;

	await db
		.prepare(
			`INSERT INTO filters (
				id, name, slug, description, thumbnail_url, category,
				provider_model_id, config, input_media_types, provider_name,
				prompt_template, default_params_json, is_active, coin_cost,
				tag_id, preview_image_url, model_key, operation_type, is_featured,
				sort_order, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			filter.id,
			filter.name,
			filter.slug,
			filter.description,
			filter.thumbnail_url,
			filter.category,
			filter.provider_model_id,
			filter.config,
			filter.input_media_types,
			filter.provider_name,
			filter.prompt_template,
			filter.default_params_json,
			filter.is_active,
			filter.coin_cost,
			filter.tag_id,
			filter.preview_image_url,
			filter.model_key,
			filter.operation_type,
			filter.is_featured,
			filter.sort_order,
			filter.created_at,
			filter.updated_at,
		)
		.run();

	return filter;
}

export async function insertTag(
	overrides: Partial<TagRow> = {},
	db: D1Database = env.DB,
) {
	const tagId = overrides.id ?? crypto.randomUUID();
	const now = nowIso();
	const tag = {
		id: tagId,
		slug: overrides.slug ?? `tag-${tagId}`,
		name: overrides.name ?? "Test Tag",
		is_active: overrides.is_active ?? 1,
		sort_order: overrides.sort_order ?? 0,
		created_at: overrides.created_at ?? now,
		updated_at: overrides.updated_at ?? now,
	} satisfies TagRow;

	await db
		.prepare(
			`INSERT INTO tags (
				id, slug, name, is_active, sort_order, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			tag.id,
			tag.slug,
			tag.name,
			tag.is_active,
			tag.sort_order,
			tag.created_at,
			tag.updated_at,
		)
		.run();

	return tag;
}

export function makeRevenueCatEvent(
	overrides: Partial<RCWebhookPayload["event"]> & {
		type: string;
		app_user_id: string;
		product_id: string;
	}): RCWebhookPayload {
	return {
		api_version: "1.0",
		event: {
			id: overrides.id ?? id("rc-event"),
			type: overrides.type,
			app_user_id: overrides.app_user_id,
			product_id: overrides.product_id,
			entitlement_ids: overrides.entitlement_ids,
			expiration_at_ms:
				overrides.expiration_at_ms ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
			purchased_at_ms: overrides.purchased_at_ms ?? Date.now(),
			store: overrides.store ?? "APP_STORE",
			environment: overrides.environment ?? "SANDBOX",
		},
	};
}
