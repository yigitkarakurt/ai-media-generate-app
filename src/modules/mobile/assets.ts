import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../../middleware/dev-auth";
import { devAuth } from "../../middleware/dev-auth";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import { AppError } from "../../shared/errors";
import type { AssetRow } from "../../core/db/schema";
import { toClientAsset } from "../../core/assets/client";

/* ──────────────── Validation schemas ──────────────── */

const listAssetsQuery = paginationQuery.extend({
	kind: z.enum(["input", "output"]).optional(),
	media_type: z.enum(["image", "video"]).optional(),
	status: z.enum(["pending", "uploaded", "processing", "ready", "failed"]).optional(),
});

/* ──────────────── Router ──────────────── */

const assets = new Hono<AuthedEnv>();

// All asset routes require authentication
assets.use("/*", devAuth);

/**
 * GET /api/mobile/assets
 *
 * List the authenticated user's assets.
 * Supports optional filtering by kind, media_type, and status.
 * Sorted newest first. Includes signed read URLs for readable assets.
 */
assets.get("/", async (c) => {
	const query = parseQuery(c.req.url, listAssetsQuery);
	const { page, pageSize } = query;
	const userId = c.get("userId");
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	// Build dynamic WHERE clause
	const conditions: string[] = ["user_id = ?"];
	const values: unknown[] = [userId];

	if (query.kind) {
		conditions.push("kind = ?");
		values.push(query.kind);
	}
	if (query.media_type) {
		conditions.push("type = ?");
		values.push(query.media_type);
	}
	if (query.status) {
		conditions.push("status = ?");
		values.push(query.status);
	}

	const whereClause = conditions.join(" AND ");

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				`SELECT * FROM assets WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
			)
			.bind(...values, pageSize, offset)
			.all<AssetRow>(),
		db
			.prepare(`SELECT COUNT(*) as total FROM assets WHERE ${whereClause}`)
			.bind(...values)
			.first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;
	const clientAssets = await Promise.all(
		rows.results.map((row) => toClientAsset(row, c.env)),
	);

	return paginated(c, clientAssets, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/**
 * GET /api/mobile/assets/:id
 *
 * Get a single asset by ID (owned by the authenticated user).
 * Returns client-safe metadata with a signed read URL if the asset is in R2.
 */
assets.get("/:id", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("userId");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?")
		.bind(id, userId)
		.first<AssetRow>();

	if (!row) {
		throw AppError.notFound("Asset");
	}

	const clientAsset = await toClientAsset(row, c.env);
	return success(c, clientAsset);
});

export { assets as mobileAssetRoutes };
