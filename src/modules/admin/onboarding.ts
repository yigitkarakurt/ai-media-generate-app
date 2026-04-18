import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import { AppError } from "../../shared/errors";
import type { OnboardingFlowRow, OnboardingScreenRow } from "../../core/db/schema";

/* ──────────────── Validation ──────────────── */

const VALID_MEDIA_TYPES = ["image", "gif", "video"] as const;

const createScreenSchema = z.object({
	flow_id: z.string().uuid(),
	title: z.string().min(1).max(200),
	subtitle: z.string().max(300).default(""),
	description: z.string().max(1000).default(""),
	media_type: z.enum(VALID_MEDIA_TYPES),
	media_url: z.string().url(),
	cta_text: z.string().max(100).default(""),
	secondary_cta_text: z.string().max(100).nullable().default(null),
	sort_order: z.number().int().min(0).default(0),
	is_active: z.boolean().default(true),
});

const updateScreenSchema = createScreenSchema.omit({ flow_id: true }).partial();

const createFlowSchema = z.object({
	key: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	name: z.string().min(1).max(200),
	is_active: z.boolean().default(false),
});

const updateFlowSchema = createFlowSchema.partial();

/* ──────────────── Transforms ──────────────── */

function toAdminFlow(row: OnboardingFlowRow) {
	return { ...row, is_active: Boolean(row.is_active) };
}

function toAdminScreen(row: OnboardingScreenRow) {
	return { ...row, is_active: Boolean(row.is_active) };
}

/* ──────────────── Router ──────────────── */

const onboarding = new Hono<AppEnv>();

/* ═══════════════ Flows ═══════════════ */

/** List onboarding flows. */
onboarding.get("/flows", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	const [rows, countResult] = await Promise.all([
		db
			.prepare("SELECT * FROM onboarding_flows ORDER BY created_at DESC LIMIT ? OFFSET ?")
			.bind(pageSize, offset)
			.all<OnboardingFlowRow>(),
		db.prepare("SELECT COUNT(*) as total FROM onboarding_flows").first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results.map(toAdminFlow), {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Create an onboarding flow. */
onboarding.post("/flows", async (c) => {
	const data = createFlowSchema.parse(await c.req.json());
	const db = c.env.DB;
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	// If activating this flow, deactivate all others
	if (data.is_active) {
		await db.prepare("UPDATE onboarding_flows SET is_active = 0, updated_at = ?").bind(now).run();
	}

	await db
		.prepare(
			`INSERT INTO onboarding_flows (id, key, name, is_active, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, data.key, data.name, data.is_active ? 1 : 0, now, now)
		.run();

	const created = await db
		.prepare("SELECT * FROM onboarding_flows WHERE id = ?")
		.bind(id)
		.first<OnboardingFlowRow>();

	return success(c, created ? toAdminFlow(created) : null, 201);
});

/** Update an onboarding flow. */
onboarding.patch("/flows/:id", async (c) => {
	const id = c.req.param("id");
	const data = updateFlowSchema.parse(await c.req.json());
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT * FROM onboarding_flows WHERE id = ?")
		.bind(id)
		.first<OnboardingFlowRow>();

	if (!existing) {
		throw AppError.notFound("Onboarding flow");
	}

	const sets: string[] = [];
	const values: unknown[] = [];

	if (data.key !== undefined) { sets.push("key = ?"); values.push(data.key); }
	if (data.name !== undefined) { sets.push("name = ?"); values.push(data.name); }

	const now = new Date().toISOString();

	// If activating this flow, deactivate all others first
	if (data.is_active === true) {
		await db.prepare("UPDATE onboarding_flows SET is_active = 0, updated_at = ?").bind(now).run();
		sets.push("is_active = ?");
		values.push(1);
	} else if (data.is_active === false) {
		sets.push("is_active = ?");
		values.push(0);
	}

	if (sets.length === 0) {
		return success(c, toAdminFlow(existing));
	}

	sets.push("updated_at = ?");
	values.push(now);
	values.push(id);

	await db
		.prepare(`UPDATE onboarding_flows SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await db
		.prepare("SELECT * FROM onboarding_flows WHERE id = ?")
		.bind(id)
		.first<OnboardingFlowRow>();

	return success(c, updated ? toAdminFlow(updated) : null);
});

/* ═══════════════ Screens ═══════════════ */

/** List onboarding screens (optionally filtered by flow_id). */
onboarding.get("/screens", async (c) => {
	const { page, pageSize } = parseQuery(c.req.url, paginationQuery);
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;
	const flowId = new URL(c.req.url).searchParams.get("flow_id");

	const whereClause = flowId ? "WHERE flow_id = ?" : "";
	const bindValues = flowId ? [pageSize, offset, flowId] : [pageSize, offset];

	// Build queries with optional flow_id filter
	const listSql = flowId
		? "SELECT * FROM onboarding_screens WHERE flow_id = ? ORDER BY sort_order ASC LIMIT ? OFFSET ?"
		: "SELECT * FROM onboarding_screens ORDER BY sort_order ASC LIMIT ? OFFSET ?";
	const countSql = flowId
		? "SELECT COUNT(*) as total FROM onboarding_screens WHERE flow_id = ?"
		: "SELECT COUNT(*) as total FROM onboarding_screens";

	const listBinds = flowId ? [flowId, pageSize, offset] : [pageSize, offset];
	const countBinds = flowId ? [flowId] : [];

	const [rows, countResult] = await Promise.all([
		db.prepare(listSql).bind(...listBinds).all<OnboardingScreenRow>(),
		countBinds.length > 0
			? db.prepare(countSql).bind(...countBinds).first<{ total: number }>()
			: db.prepare(countSql).first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results.map(toAdminScreen), {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

/** Create an onboarding screen. */
onboarding.post("/screens", async (c) => {
	const data = createScreenSchema.parse(await c.req.json());
	const db = c.env.DB;

	// Verify flow exists
	const flow = await db
		.prepare("SELECT id FROM onboarding_flows WHERE id = ?")
		.bind(data.flow_id)
		.first<{ id: string }>();

	if (!flow) {
		throw AppError.badRequest("INVALID_FLOW_ID", "Onboarding flow not found");
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO onboarding_screens (
				id, flow_id, title, subtitle, description,
				media_type, media_url, cta_text, secondary_cta_text,
				sort_order, is_active, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.flow_id,
			data.title,
			data.subtitle,
			data.description,
			data.media_type,
			data.media_url,
			data.cta_text,
			data.secondary_cta_text,
			data.sort_order,
			data.is_active ? 1 : 0,
			now,
			now,
		)
		.run();

	const created = await db
		.prepare("SELECT * FROM onboarding_screens WHERE id = ?")
		.bind(id)
		.first<OnboardingScreenRow>();

	return success(c, created ? toAdminScreen(created) : null, 201);
});

/** Update an onboarding screen. */
onboarding.patch("/screens/:id", async (c) => {
	const id = c.req.param("id");
	const data = updateScreenSchema.parse(await c.req.json());
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT * FROM onboarding_screens WHERE id = ?")
		.bind(id)
		.first<OnboardingScreenRow>();

	if (!existing) {
		throw AppError.notFound("Onboarding screen");
	}

	const sets: string[] = [];
	const values: unknown[] = [];

	if (data.title !== undefined) { sets.push("title = ?"); values.push(data.title); }
	if (data.subtitle !== undefined) { sets.push("subtitle = ?"); values.push(data.subtitle); }
	if (data.description !== undefined) { sets.push("description = ?"); values.push(data.description); }
	if (data.media_type !== undefined) { sets.push("media_type = ?"); values.push(data.media_type); }
	if (data.media_url !== undefined) { sets.push("media_url = ?"); values.push(data.media_url); }
	if (data.cta_text !== undefined) { sets.push("cta_text = ?"); values.push(data.cta_text); }
	if (data.secondary_cta_text !== undefined) { sets.push("secondary_cta_text = ?"); values.push(data.secondary_cta_text); }
	if (data.sort_order !== undefined) { sets.push("sort_order = ?"); values.push(data.sort_order); }
	if (data.is_active !== undefined) { sets.push("is_active = ?"); values.push(data.is_active ? 1 : 0); }

	if (sets.length === 0) {
		return success(c, toAdminScreen(existing));
	}

	sets.push("updated_at = ?");
	values.push(new Date().toISOString());
	values.push(id);

	await db
		.prepare(`UPDATE onboarding_screens SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await db
		.prepare("SELECT * FROM onboarding_screens WHERE id = ?")
		.bind(id)
		.first<OnboardingScreenRow>();

	return success(c, updated ? toAdminScreen(updated) : null);
});

/** Delete an onboarding screen. */
onboarding.delete("/screens/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.env.DB;

	const existing = await db
		.prepare("SELECT id FROM onboarding_screens WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();

	if (!existing) {
		throw AppError.notFound("Onboarding screen");
	}

	await db.prepare("DELETE FROM onboarding_screens WHERE id = ?").bind(id).run();

	return success(c, { deleted: true });
});

export { onboarding as adminOnboardingRoutes };
