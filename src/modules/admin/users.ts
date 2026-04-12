import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { UserRow } from "../../core/db/schema";

const users = new Hono<AppEnv>();

/** List all users (admin) */
users.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?")
			.bind(pageSize, offset)
			.all<UserRow>(),
		db.prepare("SELECT COUNT(*) as total FROM users").first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single user by ID (admin) */
users.get("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM users WHERE id = ?")
		.bind(id)
		.first<UserRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "User not found" } }, 404);
	}

	return success(c, row);
});

export { users as adminUserRoutes };
