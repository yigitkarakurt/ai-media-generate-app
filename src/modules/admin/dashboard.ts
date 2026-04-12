import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success } from "../../shared/api-response";

const dashboard = new Hono<AppEnv>();

/** Admin dashboard summary stats */
dashboard.get("/", async (c) => {
	const db = c.env.DB;

	const [usersCount, jobsCount, assetsCount, activeFilters] = await Promise.all([
		db.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>(),
		db.prepare("SELECT COUNT(*) as count FROM generation_jobs").first<{ count: number }>(),
		db.prepare("SELECT COUNT(*) as count FROM assets").first<{ count: number }>(),
		db.prepare("SELECT COUNT(*) as count FROM filters WHERE is_active = 1").first<{ count: number }>(),
	]);

	return success(c, {
		totalUsers: usersCount?.count ?? 0,
		totalJobs: jobsCount?.count ?? 0,
		totalAssets: assetsCount?.count ?? 0,
		activeFilters: activeFilters?.count ?? 0,
	});
});

export { dashboard as adminDashboardRoutes };
