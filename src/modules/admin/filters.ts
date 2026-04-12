import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { FilterRow } from "../../core/db/schema";

const createFilterSchema = z.object({
	name: z.string().min(1).max(100),
	slug: z.string().min(1).max(100),
	description: z.string().max(500).default(""),
	thumbnail_url: z.string().url().default(""),
	category: z.string().min(1).max(50),
	provider_model_id: z.string().min(1),
	provider_name: z.string().min(1).max(50).default("atlas"),
	prompt_template: z.string().max(2000).default(""),
	default_params_json: z.record(z.unknown()).optional(),
	config: z.record(z.unknown()).optional(),
	input_media_types: z.string().min(1).default("image"),
	is_active: z.boolean().default(true),
	sort_order: z.number().int().min(0).default(0),
});

const updateFilterSchema = createFilterSchema.partial();

const filters = new Hono<AppEnv>();

/** List all filters including inactive (admin) */
filters.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare("SELECT * FROM filters ORDER BY sort_order ASC, created_at DESC LIMIT ? OFFSET ?")
			.bind(pageSize, offset)
			.all<FilterRow>(),
		db.prepare("SELECT COUNT(*) as total FROM filters").first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single filter by ID (admin) */
filters.get("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const row = await db.prepare("SELECT * FROM filters WHERE id = ?").bind(id).first<FilterRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Filter not found" } }, 404);
	}

	return success(c, row);
});

/** Create a new filter (admin) */
filters.post("/", async (c) => {
	const body = await c.req.json();
	const data = createFilterSchema.parse(body);
	const db = c.env.DB;
	const now = new Date().toISOString();
	const id = crypto.randomUUID();

	await db
		.prepare(
			`INSERT INTO filters (
				id, name, slug, description, thumbnail_url, category,
				provider_model_id, provider_name, prompt_template, default_params_json,
				config, input_media_types, is_active, sort_order, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.name,
			data.slug,
			data.description,
			data.thumbnail_url,
			data.category,
			data.provider_model_id,
			data.provider_name,
			data.prompt_template,
			data.default_params_json ? JSON.stringify(data.default_params_json) : null,
			data.config ? JSON.stringify(data.config) : null,
			data.input_media_types,
			data.is_active ? 1 : 0,
			data.sort_order,
			now,
			now,
		)
		.run();

	const created = await db.prepare("SELECT * FROM filters WHERE id = ?").bind(id).first<FilterRow>();
	return success(c, created, 201);
});

/** Update a filter (admin) */
filters.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const data = updateFilterSchema.parse(body);
	const db = c.env.DB;

	const existing = await db.prepare("SELECT * FROM filters WHERE id = ?").bind(id).first<FilterRow>();
	if (!existing) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Filter not found" } }, 404);
	}

	const sets: string[] = [];
	const values: unknown[] = [];

	if (data.name !== undefined) { sets.push("name = ?"); values.push(data.name); }
	if (data.slug !== undefined) { sets.push("slug = ?"); values.push(data.slug); }
	if (data.description !== undefined) { sets.push("description = ?"); values.push(data.description); }
	if (data.thumbnail_url !== undefined) { sets.push("thumbnail_url = ?"); values.push(data.thumbnail_url); }
	if (data.category !== undefined) { sets.push("category = ?"); values.push(data.category); }
	if (data.provider_model_id !== undefined) { sets.push("provider_model_id = ?"); values.push(data.provider_model_id); }
	if (data.provider_name !== undefined) { sets.push("provider_name = ?"); values.push(data.provider_name); }
	if (data.prompt_template !== undefined) { sets.push("prompt_template = ?"); values.push(data.prompt_template); }
	if (data.default_params_json !== undefined) { sets.push("default_params_json = ?"); values.push(JSON.stringify(data.default_params_json)); }
	if (data.config !== undefined) { sets.push("config = ?"); values.push(JSON.stringify(data.config)); }
	if (data.input_media_types !== undefined) { sets.push("input_media_types = ?"); values.push(data.input_media_types); }
	if (data.is_active !== undefined) { sets.push("is_active = ?"); values.push(data.is_active ? 1 : 0); }
	if (data.sort_order !== undefined) { sets.push("sort_order = ?"); values.push(data.sort_order); }

	if (sets.length === 0) {
		return success(c, existing);
	}

	sets.push("updated_at = ?");
	values.push(new Date().toISOString());
	values.push(id);

	await db
		.prepare(`UPDATE filters SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await db.prepare("SELECT * FROM filters WHERE id = ?").bind(id).first<FilterRow>();
	return success(c, updated);
});

/** Delete a filter (admin) */
filters.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const result = await db.prepare("DELETE FROM filters WHERE id = ?").bind(id).run();

	if (result.meta.changes === 0) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Filter not found" } }, 404);
	}

	return success(c, { id, deleted: true });
});

export { filters as adminFilterRoutes };
