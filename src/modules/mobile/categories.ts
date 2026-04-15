import { Hono } from "hono";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { CategoryRow, FilterRow } from "../../core/db/schema";

/* ──────────────── Query row types ──────────────── */

type CategoryFilterRow = FilterRow & {
	tag_slug: string | null;
	tag_name: string | null;
	tag_is_active: number | null;
	pp_id: string | null;
	pp_url: string | null;
	pp_media_type: string | null;
};

/* ──────────────── Client-safe transforms ──────────────── */

function toClientCategory(row: CategoryRow) {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		sort_order: row.sort_order,
	};
}

function toClientFilter(row: CategoryFilterRow) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		coin_cost: row.coin_cost,
		input_media_types: row.input_media_types,
		is_featured: Boolean(row.is_featured),
		tag: row.tag_id && row.tag_is_active
			? { id: row.tag_id, slug: row.tag_slug, name: row.tag_name }
			: null,
		primary_preview: row.pp_id
			? { id: row.pp_id, preview_url: row.pp_url, media_type: row.pp_media_type }
			: row.preview_image_url
				? { id: null, preview_url: row.preview_image_url, media_type: "image" }
				: null,
	};
}

/* ──────────────── Router ──────────────── */

const categories = new Hono<AuthedEnv>();

categories.use("/*", requireAuth);

/** List active categories for mobile clients */
categories.get("/", async (c) => {
	const db = c.env.DB;

	const rows = await db
		.prepare(
			`SELECT * FROM categories
			WHERE is_active = 1
			ORDER BY sort_order ASC, name ASC`,
		)
		.all<CategoryRow>();

	return success(c, rows.results.map(toClientCategory));
});

/** List active filters in a category (paginated) */
categories.get("/:slug/filters", async (c) => {
	const slug = c.req.param("slug");
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const category = await db
		.prepare("SELECT * FROM categories WHERE slug = ? AND is_active = 1")
		.bind(slug)
		.first<CategoryRow>();

	if (!category) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } }, 404);
	}

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				`SELECT f.id, f.name, f.slug, f.description, f.coin_cost,
						f.input_media_types, f.is_featured, f.is_active,
						f.sort_order, f.tag_id, f.preview_image_url, f.thumbnail_url,
						t.slug AS tag_slug, t.name AS tag_name, t.is_active AS tag_is_active,
						fp.id AS pp_id, fp.preview_url AS pp_url, fp.media_type AS pp_media_type
				FROM filter_categories fc
				JOIN filters f ON f.id = fc.filter_id AND f.is_active = 1
				LEFT JOIN tags t ON t.id = f.tag_id
				LEFT JOIN filter_previews fp ON fp.filter_id = f.id AND fp.is_primary = 1
				WHERE fc.category_id = ?
				ORDER BY fc.sort_order ASC
				LIMIT ? OFFSET ?`,
			)
			.bind(category.id, pageSize, offset)
			.all<CategoryFilterRow>(),
		db
			.prepare(
				`SELECT COUNT(*) as total
				FROM filter_categories fc
				JOIN filters f ON f.id = fc.filter_id AND f.is_active = 1
				WHERE fc.category_id = ?`,
			)
			.bind(category.id)
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

export { categories as mobileCategoryRoutes };
