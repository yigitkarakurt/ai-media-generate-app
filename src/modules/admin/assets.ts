import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { AssetRow } from "../../core/db/schema";

const assets = new Hono<AppEnv>();

/** List all assets (admin) */
assets.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare("SELECT * FROM assets ORDER BY created_at DESC LIMIT ? OFFSET ?")
			.bind(pageSize, offset)
			.all<AssetRow>(),
		db.prepare("SELECT COUNT(*) as total FROM assets").first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single asset by ID (admin) */
assets.get("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM assets WHERE id = ?")
		.bind(id)
		.first<AssetRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Asset not found" } }, 404);
	}

	return success(c, row);
});

/** Delete an asset (admin) */
assets.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT storage_key FROM assets WHERE id = ?")
		.bind(id)
		.first<{ storage_key: string }>();

	if (!existing) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Asset not found" } }, 404);
	}

	// Delete from DB. R2 cleanup will be added with storage implementation.
	await db.prepare("DELETE FROM assets WHERE id = ?").bind(id).run();

	return success(c, { id, deleted: true });
});

export { assets as adminAssetRoutes };
