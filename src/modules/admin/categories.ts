import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { CategoryRow } from "../../core/db/schema";
import { AppError } from "../../shared/errors";

/* ──────────────── Validation ──────────────── */

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const createCategorySchema = z.object({
	slug: z.string().min(1).max(80).regex(slugRegex),
	name: z.string().min(1).max(100),
	description: z.string().max(500).default(""),
	is_active: z.boolean().default(true),
	sort_order: z.number().int().min(0).default(0),
	show_on_home: z.boolean().default(false),
	home_sort_order: z.number().int().min(0).default(0),
});

const updateCategorySchema = createCategorySchema.partial();

const setCategoryFiltersSchema = z.object({
	filters: z.array(
		z.object({
			filter_id: z.string().uuid(),
			sort_order: z.number().int().min(0).default(0),
		}),
	),
});

/* ──────────────── Helpers ──────────────── */

function toAdminCategory(row: CategoryRow) {
	return {
		...row,
		is_active: Boolean(row.is_active),
		show_on_home: Boolean(row.show_on_home),
	};
}

/* ──────────────── Router ──────────────── */

const categories = new Hono<AppEnv>();

/** List all categories (admin) */
categories.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare("SELECT * FROM categories ORDER BY sort_order ASC, name ASC LIMIT ? OFFSET ?")
			.bind(pageSize, offset)
			.all<CategoryRow>(),
		db.prepare("SELECT COUNT(*) as total FROM categories").first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results.map(toAdminCategory), {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single category (admin) */
categories.get("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM categories WHERE id = ?")
		.bind(id)
		.first<CategoryRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } }, 404);
	}

	return success(c, toAdminCategory(row));
});

/** Create a category (admin) */
categories.post("/", async (c) => {
	const data = createCategorySchema.parse(await c.req.json());
	const db = c.env.DB;
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO categories (
				id, slug, name, description, is_active, sort_order,
				show_on_home, home_sort_order, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.slug,
			data.name,
			data.description,
			data.is_active ? 1 : 0,
			data.sort_order,
			data.show_on_home ? 1 : 0,
			data.home_sort_order,
			now,
			now,
		)
		.run();

	const created = await db
		.prepare("SELECT * FROM categories WHERE id = ?")
		.bind(id)
		.first<CategoryRow>();

	return success(c, created ? toAdminCategory(created) : null, 201);
});

/** Update a category (admin) */
categories.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const data = updateCategorySchema.parse(await c.req.json());
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT * FROM categories WHERE id = ?")
		.bind(id)
		.first<CategoryRow>();

	if (!existing) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } }, 404);
	}

	const sets: string[] = [];
	const values: unknown[] = [];

	if (data.slug !== undefined) { sets.push("slug = ?"); values.push(data.slug); }
	if (data.name !== undefined) { sets.push("name = ?"); values.push(data.name); }
	if (data.description !== undefined) { sets.push("description = ?"); values.push(data.description); }
	if (data.is_active !== undefined) { sets.push("is_active = ?"); values.push(data.is_active ? 1 : 0); }
	if (data.sort_order !== undefined) { sets.push("sort_order = ?"); values.push(data.sort_order); }
	if (data.show_on_home !== undefined) { sets.push("show_on_home = ?"); values.push(data.show_on_home ? 1 : 0); }
	if (data.home_sort_order !== undefined) { sets.push("home_sort_order = ?"); values.push(data.home_sort_order); }

	if (sets.length === 0) {
		return success(c, toAdminCategory(existing));
	}

	sets.push("updated_at = ?");
	values.push(new Date().toISOString());
	values.push(id);

	await db
		.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await db
		.prepare("SELECT * FROM categories WHERE id = ?")
		.bind(id)
		.first<CategoryRow>();

	return success(c, updated ? toAdminCategory(updated) : null);
});

/** Delete a category (admin) */
categories.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const result = await db.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();

	if (result.meta.changes === 0) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } }, 404);
	}

	// Clean up join table entries
	await db.prepare("DELETE FROM filter_categories WHERE category_id = ?").bind(id).run();

	return success(c, { id, deleted: true });
});

/** List filters in a category (admin) */
categories.get("/:id/filters", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const category = await db
		.prepare("SELECT id FROM categories WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();

	if (!category) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } }, 404);
	}

	const rows = await db
		.prepare(
			`SELECT f.id, f.name, f.slug, f.is_active, f.sort_order, fc.sort_order AS category_sort_order
			FROM filter_categories fc
			JOIN filters f ON f.id = fc.filter_id
			WHERE fc.category_id = ?
			ORDER BY fc.sort_order ASC`,
		)
		.bind(id)
		.all();

	return success(c, rows.results);
});

/** Replace all filter assignments for a category (admin) */
categories.put("/:id/filters", async (c) => {
	const id = c.req.param("id");
	const body = setCategoryFiltersSchema.parse(await c.req.json());
	const db = c.env.DB;

	const category = await db
		.prepare("SELECT id FROM categories WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();

	if (!category) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } }, 404);
	}

	// Validate all filter IDs exist
	for (const entry of body.filters) {
		const f = await db
			.prepare("SELECT id FROM filters WHERE id = ?")
			.bind(entry.filter_id)
			.first<{ id: string }>();
		if (!f) {
			throw AppError.badRequest("INVALID_FILTER_ID", `Filter ${entry.filter_id} does not exist`);
		}
	}

	// Delete existing assignments and insert new ones
	await db.prepare("DELETE FROM filter_categories WHERE category_id = ?").bind(id).run();

	for (const entry of body.filters) {
		await db
			.prepare("INSERT INTO filter_categories (filter_id, category_id, sort_order) VALUES (?, ?, ?)")
			.bind(entry.filter_id, id, entry.sort_order)
			.run();
	}

	// Return updated list
	const rows = await db
		.prepare(
			`SELECT f.id, f.name, f.slug, fc.sort_order AS category_sort_order
			FROM filter_categories fc
			JOIN filters f ON f.id = fc.filter_id
			WHERE fc.category_id = ?
			ORDER BY fc.sort_order ASC`,
		)
		.bind(id)
		.all();

	return success(c, rows.results);
});

export { categories as adminCategoryRoutes };
