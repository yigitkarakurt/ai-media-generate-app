import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { FilterRow } from "../../core/db/schema";

/** Strips provider-internal fields the mobile client should never see. */
function toClientFilter(row: FilterRow) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		thumbnail_url: row.thumbnail_url,
		category: row.category,
		input_media_types: row.input_media_types,
		sort_order: row.sort_order,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

const filters = new Hono<AppEnv>();

/** List active filters for mobile clients */
filters.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				"SELECT * FROM filters WHERE is_active = 1 ORDER BY sort_order ASC LIMIT ? OFFSET ?",
			)
			.bind(pageSize, offset)
			.all<FilterRow>(),
		db
			.prepare("SELECT COUNT(*) as total FROM filters WHERE is_active = 1")
			.first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results.map(toClientFilter), {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single filter by slug */
filters.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM filters WHERE slug = ? AND is_active = 1")
		.bind(slug)
		.first<FilterRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Filter not found" } }, 404);
	}

	return success(c, toClientFilter(row));
});

export { filters as mobileFilterRoutes };
