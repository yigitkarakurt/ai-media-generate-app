import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import type { TrackingEventRow } from "../../core/db/schema";
import { z } from "zod";

/* ──────────────── Query schema ──────────────── */

const listTrackingQuery = paginationQuery.extend({
	event_name: z.string().optional(),
	user_id: z.string().optional(),
});

/* ──────────────── Router ──────────────── */

const tracking = new Hono<AppEnv>();

/**
 * GET /api/admin/tracking/events
 *
 * Paginated list of raw tracking event rows.
 * Supports filtering by event_name and user_id.
 * Sorted newest-first.
 *
 * Authentication is enforced by the global admin middleware in index.ts.
 */
tracking.get("/events", async (c) => {
	const query = parseQuery(c.req.url, listTrackingQuery);
	const { page, pageSize } = query;
	const offset = (page - 1) * pageSize;
	const db = c.env.DB;

	// Build WHERE clause fragments
	const filters: string[] = [];
	const binds: unknown[] = [];

	if (query.event_name) {
		filters.push("event_name = ?");
		binds.push(query.event_name);
	}
	if (query.user_id) {
		filters.push("user_id = ?");
		binds.push(query.user_id);
	}

	const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				`SELECT * FROM tracking_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
			)
			.bind(...binds, pageSize, offset)
			.all<TrackingEventRow>(),
		db
			.prepare(`SELECT COUNT(*) as total FROM tracking_events ${where}`)
			.bind(...binds)
			.first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return success(c, {
		events: rows.results,
		pagination: {
			page,
			pageSize,
			total,
			totalPages: Math.ceil(total / pageSize),
		},
	});
});

export { tracking as adminTrackingRoutes };
