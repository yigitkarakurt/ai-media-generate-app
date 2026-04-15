import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { TagRow } from "../../core/db/schema";

const tagSchema = z.object({
	slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	name: z.string().min(1).max(100),
	is_active: z.boolean().default(true),
	sort_order: z.number().int().min(0).default(0),
});

const updateTagSchema = tagSchema.partial();

function toAdminTag(row: TagRow) {
	return {
		...row,
		is_active: Boolean(row.is_active),
	};
}

const tags = new Hono<AppEnv>();

/** List tags for admin tag pickers and management screens. */
tags.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare("SELECT * FROM tags ORDER BY sort_order ASC, name ASC LIMIT ? OFFSET ?")
			.bind(pageSize, offset)
			.all<TagRow>(),
		db.prepare("SELECT COUNT(*) as total FROM tags").first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results.map(toAdminTag), {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single tag. */
tags.get("/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB
		.prepare("SELECT * FROM tags WHERE id = ?")
		.bind(id)
		.first<TagRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Tag not found" } }, 404);
	}

	return success(c, toAdminTag(row));
});

/** Create a tag. */
tags.post("/", async (c) => {
	const data = tagSchema.parse(await c.req.json());
	const db = c.env.DB;
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO tags (
				id, slug, name, is_active, sort_order, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.slug,
			data.name,
			data.is_active ? 1 : 0,
			data.sort_order,
			now,
			now,
		)
		.run();

	const created = await db
		.prepare("SELECT * FROM tags WHERE id = ?")
		.bind(id)
		.first<TagRow>();

	return success(c, created ? toAdminTag(created) : null, 201);
});

/** Update a tag. Soft deletion is represented by is_active=false. */
tags.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const data = updateTagSchema.parse(await c.req.json());
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT * FROM tags WHERE id = ?")
		.bind(id)
		.first<TagRow>();

	if (!existing) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Tag not found" } }, 404);
	}

	const sets: string[] = [];
	const values: unknown[] = [];

	if (data.slug !== undefined) { sets.push("slug = ?"); values.push(data.slug); }
	if (data.name !== undefined) { sets.push("name = ?"); values.push(data.name); }
	if (data.is_active !== undefined) { sets.push("is_active = ?"); values.push(data.is_active ? 1 : 0); }
	if (data.sort_order !== undefined) { sets.push("sort_order = ?"); values.push(data.sort_order); }

	if (sets.length === 0) {
		return success(c, toAdminTag(existing));
	}

	sets.push("updated_at = ?");
	values.push(new Date().toISOString());
	values.push(id);

	await db
		.prepare(`UPDATE tags SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await db
		.prepare("SELECT * FROM tags WHERE id = ?")
		.bind(id)
		.first<TagRow>();

	return success(c, updated ? toAdminTag(updated) : null);
});

export { tags as adminTagRoutes };
