import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success } from "../../shared/api-response";
import type { AdminSettingRow } from "../../core/db/schema";

const updateSettingSchema = z.object({
	value: z.string(),
	description: z.string().optional(),
});

const settings = new Hono<AppEnv>();

/** Get all settings (admin) */
settings.get("/", async (c) => {
	const db = c.env.DB;
	const rows = await db
		.prepare("SELECT * FROM admin_settings ORDER BY key ASC")
		.all<AdminSettingRow>();

	return success(c, rows.results);
});

/** Get a single setting by key (admin) */
settings.get("/:key", async (c) => {
	const key = c.req.param("key");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM admin_settings WHERE key = ?")
		.bind(key)
		.first<AdminSettingRow>();

	if (!row) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Setting not found" } }, 404);
	}

	return success(c, row);
});

/** Create or update a setting (admin) */
settings.put("/:key", async (c) => {
	const key = c.req.param("key");
	const body = await c.req.json();
	const data = updateSettingSchema.parse(body);
	const db = c.env.DB;
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO admin_settings (key, value, description, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, description = COALESCE(excluded.description, description), updated_at = excluded.updated_at`,
		)
		.bind(key, data.value, data.description ?? null, now)
		.run();

	const updated = await db
		.prepare("SELECT * FROM admin_settings WHERE key = ?")
		.bind(key)
		.first<AdminSettingRow>();

	return success(c, updated);
});

/** Delete a setting (admin) */
settings.delete("/:key", async (c) => {
	const key = c.req.param("key");
	const db = c.env.DB;

	const result = await db.prepare("DELETE FROM admin_settings WHERE key = ?").bind(key).run();

	if (result.meta.changes === 0) {
		return c.json({ success: false, error: { code: "NOT_FOUND", message: "Setting not found" } }, 404);
	}

	return success(c, { key, deleted: true });
});

export { settings as adminSettingRoutes };
