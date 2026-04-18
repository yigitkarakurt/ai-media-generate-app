import { Hono } from "hono";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { FilterRow, FilterPreviewRow, CategoryRow } from "../../core/db/schema";
import { LIST_PREVIEW_LIMIT, fetchPreviewsByFilterIds, toClientPreview } from "./_previews";

/* ──────────────── Query row types ──────────────── */

type FilterCatalogRow = FilterRow & {
	tag_slug: string | null;
	tag_name: string | null;
	tag_is_active: number | null;
};

/* ──────────────── Client-safe transforms ──────────────── */

/** Strips provider-internal fields the mobile client should never see. */
function toClientFilter(row: FilterCatalogRow) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		coin_cost: row.coin_cost,
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

function toClientCategoryRef(row: CategoryRow) {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
	};
}

/* ──────────────── SQL fragments ──────────────── */

const CATALOG_SELECT = `
	SELECT
		f.*,
		t.slug AS tag_slug,
		t.name AS tag_name,
		t.is_active AS tag_is_active
	FROM filters f
	LEFT JOIN tags t ON t.id = f.tag_id`;

/* ──────────────── Router ──────────────── */

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
				`${CATALOG_SELECT}
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
	const previewsByFilter = await fetchPreviewsByFilterIds(
		db,
		rows.results.map((r) => r.id),
		LIST_PREVIEW_LIMIT,
	);

	const data = rows.results.map((row) => ({
		...toClientFilter(row),
		previews: previewsByFilter.get(row.id) ?? [],
	}));

	return paginated(c, data, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single filter by slug — includes full preview gallery and categories */
filters.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	const db = c.env.DB;

	const row = await db
		.prepare(`${CATALOG_SELECT} WHERE f.slug = ? AND f.is_active = 1`)
		.bind(slug)
		.first<FilterCatalogRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Filter not found" } }, 404);
	}

	// Fetch full preview gallery and categories in parallel
	const [previews, categoryRows] = await Promise.all([
		db
			.prepare("SELECT * FROM filter_previews WHERE filter_id = ? ORDER BY sort_order ASC")
			.bind(row.id)
			.all<FilterPreviewRow>(),
		db
			.prepare(
				`SELECT c.id, c.slug, c.name, c.description, c.sort_order,
						c.is_active, c.show_on_home, c.home_sort_order,
						c.created_at, c.updated_at
				FROM filter_categories fc
				JOIN categories c ON c.id = fc.category_id AND c.is_active = 1
				WHERE fc.filter_id = ?
				ORDER BY fc.sort_order ASC`,
			)
			.bind(row.id)
			.all<CategoryRow>(),
	]);

	return success(c, {
		...toClientFilter(row),
		previews: previews.results.map(toClientPreview),
		categories: categoryRows.results.map(toClientCategoryRef),
	});
});

export { filters as mobileFilterRoutes };
