import { Hono } from "hono";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success } from "../../shared/api-response";
import type { FilterRow, CategoryRow } from "../../core/db/schema";

/* ──────────────── Query row types ──────────────── */

type HomeCatalogRow = FilterRow & {
	tag_slug: string | null;
	tag_name: string | null;
	tag_is_active: number | null;
	pp_id: string | null;
	pp_url: string | null;
	pp_media_type: string | null;
};

/* ──────────────── Client-safe transforms ──────────────── */

function toHomeFilter(row: HomeCatalogRow) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		coin_cost: row.coin_cost,
		input_media_types: row.input_media_types,
		is_featured: Boolean(row.is_featured),
		sort_order: row.sort_order,
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

function toHomeCategory(cat: CategoryRow) {
	return {
		id: cat.id,
		slug: cat.slug,
		name: cat.name,
		description: cat.description,
	};
}

/* ──────────────── SQL fragments ──────────────── */

const CATALOG_FILTER_SELECT = `
	SELECT f.id, f.name, f.slug, f.description, f.coin_cost,
		   f.input_media_types, f.is_featured, f.is_active,
		   f.sort_order, f.featured_sort_order, f.tag_id,
		   f.preview_image_url, f.thumbnail_url,
		   t.slug AS tag_slug, t.name AS tag_name, t.is_active AS tag_is_active,
		   fp.id AS pp_id, fp.preview_url AS pp_url, fp.media_type AS pp_media_type
	FROM filters f
	LEFT JOIN tags t ON t.id = f.tag_id
	LEFT JOIN filter_previews fp ON fp.filter_id = f.id AND fp.is_primary = 1`;

/* ──────────────── Router ──────────────── */

const home = new Hono<AuthedEnv>();

home.use("/*", requireAuth);

/**
 * GET /api/mobile/home
 *
 * Returns the data needed to render the mobile home screen:
 * - featured: featured filters ordered by featured_sort_order
 * - categories: home-visible categories, each with up to 10 filters
 */
home.get("/", async (c) => {
	const db = c.env.DB;

	// 1. Featured filters
	const featuredRows = await db
		.prepare(
			`${CATALOG_FILTER_SELECT}
			WHERE f.is_active = 1 AND f.is_featured = 1
			ORDER BY f.featured_sort_order ASC, f.sort_order ASC
			LIMIT 20`,
		)
		.all<HomeCatalogRow>();

	// 2. Home categories
	const categoryRows = await db
		.prepare(
			`SELECT * FROM categories
			WHERE is_active = 1 AND show_on_home = 1
			ORDER BY home_sort_order ASC
			LIMIT 20`,
		)
		.all<CategoryRow>();

	// 3. For each home category, fetch its first 10 active filters
	const categorySections = await Promise.all(
		categoryRows.results.map(async (cat) => {
			const filterRows = await db
				.prepare(
					`${CATALOG_FILTER_SELECT}
					JOIN filter_categories fc ON fc.filter_id = f.id
					WHERE fc.category_id = ? AND f.is_active = 1
					ORDER BY fc.sort_order ASC
					LIMIT 10`,
				)
				.bind(cat.id)
				.all<HomeCatalogRow>();

			return {
				...toHomeCategory(cat),
				filters: filterRows.results.map(toHomeFilter),
			};
		}),
	);

	return success(c, {
		featured: featuredRows.results.map(toHomeFilter),
		categories: categorySections,
	});
});

export { home as mobileHomeRoutes };
