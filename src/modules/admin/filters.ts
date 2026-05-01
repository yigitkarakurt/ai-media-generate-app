import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { FilterRow, FilterPreviewRow } from "../../core/db/schema";
import { AppError } from "../../shared/errors";

/* ──────────────── Shared helpers ──────────────── */

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

/* ──────────────── Filter schemas ──────────────── */

/**
 * Allowed operation types for filter/effect templates.
 * text_to_image and text_to_video are NOT filter operations —
 * those will be implemented as separate endpoints in a future task.
 */
const FILTER_OPERATION_TYPES = ["image_to_image", "image_to_video"] as const;
type FilterOperationType = (typeof FILTER_OPERATION_TYPES)[number];

const FILTER_OUTPUT_MEDIA_TYPES = ["image", "video"] as const;
const FILTER_INPUT_MEDIA_TYPES = ["image", "video"] as const;

/** Derive the expected output_media_type for a given operation_type. */
function expectedOutputMediaType(opType: FilterOperationType): "image" | "video" {
	return opType === "image_to_video" ? "video" : "image";
}

const filterSchemaShape = {
	name: z.string().min(1).max(100),
	slug: z.string().min(1).max(100),
	description: z.string().max(500).default(""),
	thumbnail_url: z.string().url().or(z.literal("")).default(""),
	category: z.string().min(1).max(50),
	provider_model_id: z.string().min(1).optional(),
	provider_name: z.string().min(1).max(50).default("atlas"),
	model_key: z.string().min(1).max(200),
	operation_type: z.enum(FILTER_OPERATION_TYPES, {
		errorMap: () => ({
			message: `operation_type must be one of: ${FILTER_OPERATION_TYPES.join(", ")}. text_to_image and text_to_video are not supported for filter/effect templates.`,
		}),
	}),
	output_media_type: z.enum(FILTER_OUTPUT_MEDIA_TYPES).optional(),
	prompt_template: z.string().max(2000).default(""),
	default_params_json: jsonObjectSchema.optional(),
	config: jsonObjectSchema.optional(),
	input_media_types: z.string().min(1).default("image"),
	// Input requirement fields
	requires_media: z.boolean().default(true),
	input_media_type: z.enum(FILTER_INPUT_MEDIA_TYPES).default("image"),
	min_media_count: z.number().int().min(1).default(1),
	max_media_count: z.number().int().min(1).default(1),
	supported_mime_types_json: z
		.string()
		.default('["image/jpeg","image/png","image/webp"]')
		.refine(
			(v) => {
				try {
					return Array.isArray(JSON.parse(v));
				} catch {
					return false;
				}
			},
			{ message: "supported_mime_types_json must be a valid JSON array string" },
		)
		.optional(),
	max_file_size_mb: z.number().int().min(1).max(500).default(15),
	coin_cost: z.number().int().min(0),
	tag_id: z.string().uuid().nullable().optional(),
	preview_image_url: z.string().url().or(z.literal("")).default(""),
	is_featured: z.boolean().default(false),
	featured_sort_order: z.number().int().min(0).default(0),
	is_active: z.boolean().default(true),
	sort_order: z.number().int().min(0).default(0),
};

function refineFilterCrossFields(
	data: { operation_type?: string; output_media_type?: string; min_media_count?: number; max_media_count?: number },
	ctx: z.RefinementCtx,
) {
	if (data.min_media_count !== undefined && data.max_media_count !== undefined) {
		if (data.max_media_count < data.min_media_count) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["max_media_count"],
				message: `max_media_count (${data.max_media_count}) must be >= min_media_count (${data.min_media_count})`,
			});
		}
	}
	if (data.operation_type !== undefined && data.output_media_type !== undefined) {
		const expected = expectedOutputMediaType(data.operation_type as FilterOperationType);
		if (data.output_media_type !== expected) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["output_media_type"],
				message: `output_media_type must be '${expected}' when operation_type is '${data.operation_type}'`,
			});
		}
	}
}

const createFilterSchema = z.object(filterSchemaShape).superRefine(refineFilterCrossFields);
const updateFilterSchema = z.object(filterSchemaShape).partial().superRefine(refineFilterCrossFields);



/* ──────────────── Preview schemas ──────────────── */

const ALLOWED_PREVIEW_MEDIA_TYPES = ["image", "video"] as const;

const createPreviewSchema = z.object({
	preview_url: z.string().url(),
	media_type: z.enum(ALLOWED_PREVIEW_MEDIA_TYPES).default("image"),
	sort_order: z.number().int().min(0).default(0),
	is_primary: z.boolean().default(false),
});

const updatePreviewSchema = createPreviewSchema.partial();

/* ──────────────── Category assignment schema ──────────────── */

const addCategorySchema = z.object({
	category_id: z.string().uuid(),
	sort_order: z.number().int().min(0).default(0),
});

/* ──────────────── Query helpers ──────────────── */

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
		requires_media: Boolean(row.requires_media),
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

async function assertFilterExists(db: D1Database, filterId: string) {
	const row = await db
		.prepare("SELECT id FROM filters WHERE id = ?")
		.bind(filterId)
		.first<{ id: string }>();
	if (!row) {
		throw AppError.notFound("Filter");
	}
	return row;
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

/** Derive output_media_type from operation_type if not explicitly supplied. */
function resolveOutputMediaType(
	data: z.infer<typeof createFilterSchema> | z.infer<typeof updateFilterSchema>,
	existing?: FilterRow,
): string {
	if (data.output_media_type) return data.output_media_type;
	const opType = data.operation_type ?? existing?.operation_type;
	if (opType === "image_to_video") return "video";
	return "image";
}

/* ──────────────── Router ──────────────── */

const filters = new Hono<AppEnv>();

/* ═══════════════ Filter CRUD ═══════════════ */

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
	const outputMediaType = resolveOutputMediaType(data);

	await assertTagExists(db, data.tag_id);

	await db
		.prepare(
			`INSERT INTO filters (
				id, name, slug, description, thumbnail_url, category,
				provider_model_id, provider_name, prompt_template, default_params_json,
				config, input_media_types, is_active, coin_cost, tag_id, preview_image_url,
				model_key, operation_type, is_featured, featured_sort_order, sort_order,
				requires_media, input_media_type, min_media_count, max_media_count,
				supported_mime_types_json, max_file_size_mb, output_media_type,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			data.featured_sort_order,
			data.sort_order,
			data.requires_media ? 1 : 0,
			data.input_media_type,
			data.min_media_count,
			data.max_media_count,
			data.supported_mime_types_json ?? '["image/jpeg","image/png","image/webp"]',
			data.max_file_size_mb,
			outputMediaType,
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
	if (data.operation_type !== undefined) {
		sets.push("operation_type = ?");
		values.push(data.operation_type);
		// Auto-derive output_media_type when operation_type changes and no explicit value given
		if (data.output_media_type === undefined) {
			sets.push("output_media_type = ?");
			values.push(resolveOutputMediaType(data, existing));
		}
	}
	if (data.output_media_type !== undefined) {
		// Only add if not already added above
		if (!data.operation_type) {
			sets.push("output_media_type = ?");
			values.push(data.output_media_type);
		}
	}
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
	if (data.featured_sort_order !== undefined) { sets.push("featured_sort_order = ?"); values.push(data.featured_sort_order); }
	if (data.is_active !== undefined) { sets.push("is_active = ?"); values.push(data.is_active ? 1 : 0); }
	if (data.sort_order !== undefined) { sets.push("sort_order = ?"); values.push(data.sort_order); }
	// Input requirement fields
	if (data.requires_media !== undefined) { sets.push("requires_media = ?"); values.push(data.requires_media ? 1 : 0); }
	if (data.input_media_type !== undefined) { sets.push("input_media_type = ?"); values.push(data.input_media_type); }
	if (data.min_media_count !== undefined) { sets.push("min_media_count = ?"); values.push(data.min_media_count); }
	if (data.max_media_count !== undefined) { sets.push("max_media_count = ?"); values.push(data.max_media_count); }
	if (data.supported_mime_types_json !== undefined) { sets.push("supported_mime_types_json = ?"); values.push(data.supported_mime_types_json); }
	if (data.max_file_size_mb !== undefined) { sets.push("max_file_size_mb = ?"); values.push(data.max_file_size_mb); }

	if (sets.length === 0) {
		return success(c, toAdminFilter(existing as unknown as AdminFilterRow));
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

	// Clean up related data
	await Promise.all([
		db.prepare("DELETE FROM filter_categories WHERE filter_id = ?").bind(id).run(),
		db.prepare("DELETE FROM filter_previews WHERE filter_id = ?").bind(id).run(),
	]);

	return success(c, { id, deleted: true });
});

/* ═══════════════ Filter Previews ═══════════════ */

/** List previews for a filter */
filters.get("/:id/previews", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	await assertFilterExists(db, id);

	const rows = await db
		.prepare("SELECT * FROM filter_previews WHERE filter_id = ? ORDER BY sort_order ASC")
		.bind(id)
		.all<FilterPreviewRow>();

	return success(c, rows.results.map((r) => ({ ...r, is_primary: Boolean(r.is_primary) })));
});

/** Add a preview to a filter */
filters.post("/:id/previews", async (c) => {
	const filterId = c.req.param("id");
	const data = createPreviewSchema.parse(await c.req.json());
	const db = c.env.DB;

	await assertFilterExists(db, filterId);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	// If marking as primary, clear any existing primary
	if (data.is_primary) {
		await db
			.prepare("UPDATE filter_previews SET is_primary = 0, updated_at = ? WHERE filter_id = ? AND is_primary = 1")
			.bind(now, filterId)
			.run();
	}

	await db
		.prepare(
			`INSERT INTO filter_previews (
				id, filter_id, preview_url, media_type, sort_order, is_primary,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, filterId, data.preview_url, data.media_type, data.sort_order, data.is_primary ? 1 : 0, now, now)
		.run();

	const created = await db
		.prepare("SELECT * FROM filter_previews WHERE id = ?")
		.bind(id)
		.first<FilterPreviewRow>();

	return success(c, created ? { ...created, is_primary: Boolean(created.is_primary) } : null, 201);
});

/** Update a preview */
filters.patch("/:id/previews/:previewId", async (c) => {
	const filterId = c.req.param("id");
	const previewId = c.req.param("previewId");
	const data = updatePreviewSchema.parse(await c.req.json());
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT * FROM filter_previews WHERE id = ? AND filter_id = ?")
		.bind(previewId, filterId)
		.first<FilterPreviewRow>();

	if (!existing) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Preview not found" } }, 404);
	}

	const sets: string[] = [];
	const values: unknown[] = [];
	const now = new Date().toISOString();

	// If marking as primary, clear any existing primary first
	if (data.is_primary === true) {
		await db
			.prepare("UPDATE filter_previews SET is_primary = 0, updated_at = ? WHERE filter_id = ? AND is_primary = 1 AND id != ?")
			.bind(now, filterId, previewId)
			.run();
	}

	if (data.preview_url !== undefined) { sets.push("preview_url = ?"); values.push(data.preview_url); }
	if (data.media_type !== undefined) { sets.push("media_type = ?"); values.push(data.media_type); }
	if (data.sort_order !== undefined) { sets.push("sort_order = ?"); values.push(data.sort_order); }
	if (data.is_primary !== undefined) { sets.push("is_primary = ?"); values.push(data.is_primary ? 1 : 0); }

	if (sets.length === 0) {
		return success(c, { ...existing, is_primary: Boolean(existing.is_primary) });
	}

	sets.push("updated_at = ?");
	values.push(now);
	values.push(previewId);

	await db
		.prepare(`UPDATE filter_previews SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await db
		.prepare("SELECT * FROM filter_previews WHERE id = ?")
		.bind(previewId)
		.first<FilterPreviewRow>();

	return success(c, updated ? { ...updated, is_primary: Boolean(updated.is_primary) } : null);
});

/** Delete a preview */
filters.delete("/:id/previews/:previewId", async (c) => {
	const filterId = c.req.param("id");
	const previewId = c.req.param("previewId");
	const db = c.env.DB;

	const result = await db
		.prepare("DELETE FROM filter_previews WHERE id = ? AND filter_id = ?")
		.bind(previewId, filterId)
		.run();

	if (result.meta.changes === 0) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Preview not found" } }, 404);
	}

	return success(c, { id: previewId, deleted: true });
});

/* ═══════════════ Filter ↔ Category assignments ═══════════════ */

/** List categories for a filter */
filters.get("/:id/categories", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	await assertFilterExists(db, id);

	const rows = await db
		.prepare(
			`SELECT c.id, c.slug, c.name, c.is_active, fc.sort_order AS assignment_sort_order
			FROM filter_categories fc
			JOIN categories c ON c.id = fc.category_id
			WHERE fc.filter_id = ?
			ORDER BY fc.sort_order ASC`,
		)
		.bind(id)
		.all();

	return success(c, rows.results);
});

/** Add a filter to a category */
filters.post("/:id/categories", async (c) => {
	const filterId = c.req.param("id");
	const data = addCategorySchema.parse(await c.req.json());
	const db = c.env.DB;

	await assertFilterExists(db, filterId);

	// Validate category exists
	const cat = await db
		.prepare("SELECT id FROM categories WHERE id = ?")
		.bind(data.category_id)
		.first<{ id: string }>();
	if (!cat) {
		throw AppError.badRequest("INVALID_CATEGORY_ID", "category_id must reference an existing category");
	}

	// Upsert assignment
	await db
		.prepare(
			`INSERT INTO filter_categories (filter_id, category_id, sort_order)
			VALUES (?, ?, ?)
			ON CONFLICT(filter_id, category_id) DO UPDATE SET sort_order = ?`,
		)
		.bind(filterId, data.category_id, data.sort_order, data.sort_order)
		.run();

	return success(c, { filter_id: filterId, category_id: data.category_id, sort_order: data.sort_order }, 201);
});

/** Remove a filter from a category */
filters.delete("/:id/categories/:categoryId", async (c) => {
	const filterId = c.req.param("id");
	const categoryId = c.req.param("categoryId");
	const db = c.env.DB;

	const result = await db
		.prepare("DELETE FROM filter_categories WHERE filter_id = ? AND category_id = ?")
		.bind(filterId, categoryId)
		.run();

	if (result.meta.changes === 0) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Assignment not found" } }, 404);
	}

	return success(c, { filter_id: filterId, category_id: categoryId, deleted: true });
});

export { filters as adminFilterRoutes };
