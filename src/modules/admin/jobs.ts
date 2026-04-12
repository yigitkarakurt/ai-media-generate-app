import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { GenerationJobRow } from "../../core/db/schema";

const jobs = new Hono<AppEnv>();

/** List all generation jobs (admin) */
jobs.get("/", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				"SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
			)
			.bind(pageSize, offset)
			.all<GenerationJobRow>(),
		db
			.prepare("SELECT COUNT(*) as total FROM generation_jobs")
			.first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results, {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Get a single job by ID (admin) */
jobs.get("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM generation_jobs WHERE id = ?")
		.bind(id)
		.first<GenerationJobRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Job not found" } }, 404);
	}

	return success(c, row);
});

/** Cancel a generation job (admin) */
jobs.post("/:id/cancel", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const result = await db
		.prepare(
			"UPDATE generation_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'processing')",
		)
		.bind(new Date().toISOString(), id)
		.run();

	if (result.meta.changes === 0) {
		return c.json(
			{ success: false, error: { code: "NOT_FOUND", message: "Job not found or already terminal" } },
			404,
		);
	}

	return success(c, { id, status: "cancelled" });
});

export { jobs as adminJobRoutes };
