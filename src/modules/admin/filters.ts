import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { FilterRow } from "../../core/db/schema";
import { AppError } from "../../shared/errors";

const jsonObjectSchema = z.union([
	z.record(z.unknown()),
	z.string().transform((value, ctx) => {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Expected a JSON object",
				});
				return z.NEVER;
			}
			return parsed as Record<string, unknown>;
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Invalid JSON object string",
			});
			return z.NEVER;
		}
	}),
]);

const createFilterSchema = z.object({
	name: z.string().min(1).max(100),
	slug: z.string().min(1).max(100),
	description: z.string().max(500).default(""),
	thumbnail_url: z.string().url().or(z.literal("")).default(""),
	category: z.string().min(1).max(50),
	provider_model_id: z.string().min(1).optional(),
	provider_name: z.string().min(1).max(50).default("atlas"),
	model_key: z.string().min(1).max(200),
	operation_type: z.enum(["text_to_image", "image_to_image"]),
	prompt_template: z.string().max(2000).default(""),
	default_params_json: jsonObjectSchema.optional(),
	config: jsonObjectSchema.optional(),
	input_media_types: z.string().min(1).default("image"),
	coin_cost: z.number().int().min(0),
	tag_id: z.string().uuid().nullable().optional(),
	preview_image_url: z.string().url().or(z.literal("")).default(""),
	is_featured: z.boolean().default(false),
	is_active: z.boolean().default(true),
	sort_order: z.number().int().min(0).default(0),
});

const updateFilterSchema = createFilterSchema.partial();

type AdminFilterRow = FilterRow & {
	tag_slug: string | null;
	tag_name: string | null;
	tag_is_active: number | null;
	tag_sort_order: number | null;
};

function filterSelectSql(whereClause = "") {
	return `SELECT
		f.*,
		t.slug AS tag_slug,
		t.name AS tag_name,
		t.is_active AS tag_is_active,
		t.sort_order AS tag_sort_order
	FROM filters f
	LEFT JOIN tags t ON t.id = f.tag_id
	${whereClause}`;
}

function toAdminFilter(row: AdminFilterRow) {
	return {
		...row,
		is_active: Boolean(row.is_active),
		is_featured: Boolean(row.is_featured),
		tag: row.tag_id
			? {
				id: row.tag_id,
				slug: row.tag_slug,
				name: row.tag_name,
				is_active: Boolean(row.tag_is_active),
				sort_order: row.tag_sort_order,
			}
			: null,
	};
}

async function assertTagExists(db: D1Database, tagId: string | null | undefined) {
	if (!tagId) return;
	const row = await db
		.prepare("SELECT id FROM tags WHERE id = ?")
		.bind(tagId)
		.first<{ id: string }>();
	if (!row) {
		throw AppError.badRequest("INVALID_TAG_ID", "tag_id must reference an existing tag");
	}
}

function serializeJsonObject(value: Record<string, unknown> | undefined) {
	return value === undefined ? undefined : JSON.stringify(value);
}

function buildConfig(
	data: z.infer<typeof createFilterSchema> | z.infer<typeof updateFilterSchema>,
	existing?: FilterRow,
) {
	const base = data.config !== undefined
		? data.config
		: existing?.config
			? (JSON.parse(existing.config) as Record<string, unknown>)
			: {};
	const modelKey = data.model_key ?? existing?.model_key ?? existing?.provider_model_id;
	const operationType = data.operation_type ?? existing?.operation_type;

	return {
		...base,
		...(modelKey ? { model_key: modelKey } : {}),
		...(operationType ? { operation_type: operationType } : {}),
	};
}

const filters = new Hono<AppEnv>();

/** List all filters including inactive (admin) */
filters.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare(`${filterSelectSql()} ORDER BY f.sort_order ASC, f.created_at DESC LIMIT ? OFFSET ?`)
			.bind(pageSize, offset)
			.all<AdminFilterRow>(),
		db.prepare("SELECT COUNT(*) as total FROM filters").first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results.map(toAdminFilter), {
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

	const row = await db
		.prepare(filterSelectSql("WHERE f.id = ?"))
		.bind(id)
		.first<AdminFilterRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Filter not found" } }, 404);
	}

	return success(c, toAdminFilter(row));
});

/** Create a new filter (admin) */
filters.post("/", async (c) => {
	const body = await c.req.json();
	const data = createFilterSchema.parse(body);
	const db = c.env.DB;
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const providerModelId = data.provider_model_id ?? data.model_key;
	const config = buildConfig(data);

	await assertTagExists(db, data.tag_id);

	await db
		.prepare(
			`INSERT INTO filters (
				id, name, slug, description, thumbnail_url, category,
				provider_model_id, provider_name, prompt_template, default_params_json,
				config, input_media_types, is_active, coin_cost, tag_id, preview_image_url,
				model_key, operation_type, is_featured, sort_order, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.name,
			data.slug,
			data.description,
			data.thumbnail_url,
			data.category,
			providerModelId,
			data.provider_name,
			data.prompt_template,
			data.default_params_json ? JSON.stringify(data.default_params_json) : null,
			JSON.stringify(config),
			data.input_media_types,
			data.is_active ? 1 : 0,
			data.coin_cost,
			data.tag_id ?? null,
			data.preview_image_url,
			data.model_key,
			data.operation_type,
			data.is_featured ? 1 : 0,
			data.sort_order,
			now,
			now,
		)
		.run();

	const created = await db
		.prepare(filterSelectSql("WHERE f.id = ?"))
		.bind(id)
		.first<AdminFilterRow>();
	return success(c, created ? toAdminFilter(created) : null, 201);
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

	await assertTagExists(db, data.tag_id);

	const sets: string[] = [];
	const values: unknown[] = [];

	if (data.name !== undefined) { sets.push("name = ?"); values.push(data.name); }
	if (data.slug !== undefined) { sets.push("slug = ?"); values.push(data.slug); }
	if (data.description !== undefined) { sets.push("description = ?"); values.push(data.description); }
	if (data.thumbnail_url !== undefined) { sets.push("thumbnail_url = ?"); values.push(data.thumbnail_url); }
	if (data.category !== undefined) { sets.push("category = ?"); values.push(data.category); }
	if (data.provider_model_id !== undefined) { sets.push("provider_model_id = ?"); values.push(data.provider_model_id); }
	if (data.model_key !== undefined) {
		sets.push("model_key = ?");
		values.push(data.model_key);
		if (data.provider_model_id === undefined) {
			sets.push("provider_model_id = ?");
			values.push(data.model_key);
		}
	}
	if (data.operation_type !== undefined) { sets.push("operation_type = ?"); values.push(data.operation_type); }
	if (data.provider_name !== undefined) { sets.push("provider_name = ?"); values.push(data.provider_name); }
	if (data.prompt_template !== undefined) { sets.push("prompt_template = ?"); values.push(data.prompt_template); }
	if (data.default_params_json !== undefined) { sets.push("default_params_json = ?"); values.push(serializeJsonObject(data.default_params_json)); }
	if (data.config !== undefined || data.model_key !== undefined || data.operation_type !== undefined) {
		sets.push("config = ?");
		values.push(JSON.stringify(buildConfig(data, existing)));
	}
	if (data.input_media_types !== undefined) { sets.push("input_media_types = ?"); values.push(data.input_media_types); }
	if (data.coin_cost !== undefined) { sets.push("coin_cost = ?"); values.push(data.coin_cost); }
	if (data.tag_id !== undefined) { sets.push("tag_id = ?"); values.push(data.tag_id); }
	if (data.preview_image_url !== undefined) { sets.push("preview_image_url = ?"); values.push(data.preview_image_url); }
	if (data.is_featured !== undefined) { sets.push("is_featured = ?"); values.push(data.is_featured ? 1 : 0); }
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

	const updated = await db
		.prepare(filterSelectSql("WHERE f.id = ?"))
		.bind(id)
		.first<AdminFilterRow>();
	return success(c, updated ? toAdminFilter(updated) : null);
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
