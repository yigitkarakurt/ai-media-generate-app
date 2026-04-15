import { Hono } from "hono";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { FilterRow } from "../../core/db/schema";

type FilterCatalogRow = FilterRow & {
	tag_slug: string | null;
	tag_name: string | null;
	tag_is_active: number | null;
};

/** Strips provider-internal fields the mobile client should never see. */
function toClientFilter(row: FilterCatalogRow) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		coin_cost: row.coin_cost,
		preview_image_url: row.preview_image_url || row.thumbnail_url,
		thumbnail_url: row.thumbnail_url,
		category: row.category,
		input_media_types: row.input_media_types,
		is_active: Boolean(row.is_active),
		is_featured: Boolean(row.is_featured),
		tag: row.tag_id && row.tag_is_active
			? {
				id: row.tag_id,
				slug: row.tag_slug,
				name: row.tag_name,
			}
			: null,
		sort_order: row.sort_order,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

const filters = new Hono<AuthedEnv>();

// All filter routes require authentication
filters.use("/*", requireAuth);

/** List active filters for mobile clients */
filters.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				`SELECT
					f.*,
					t.slug AS tag_slug,
					t.name AS tag_name,
					t.is_active AS tag_is_active
				FROM filters f
				LEFT JOIN tags t ON t.id = f.tag_id
				WHERE f.is_active = 1
				ORDER BY f.sort_order ASC, f.created_at DESC
				LIMIT ? OFFSET ?`,
			)
			.bind(pageSize, offset)
			.all<FilterCatalogRow>(),
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
		.prepare(
			`SELECT
				f.*,
				t.slug AS tag_slug,
				t.name AS tag_name,
				t.is_active AS tag_is_active
			FROM filters f
			LEFT JOIN tags t ON t.id = f.tag_id
			WHERE f.slug = ? AND f.is_active = 1`,
		)
		.bind(slug)
		.first<FilterCatalogRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Filter not found" } }, 404);
	}

	return success(c, toClientFilter(row));
});

export { filters as mobileFilterRoutes };
