import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../../middleware/dev-auth";
import { devAuth } from "../../middleware/dev-auth";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import { AppError } from "../../shared/errors";
import type { GenerationJobRow, AssetRow, FilterRow } from "../../core/db/schema";
import { GENERATION_STATUSES, isValidGenerationStatus } from "../../core/generation/types";
import { dispatchGeneration } from "../../core/generation/dispatch";
import { createPresignedReadUrl } from "../../lib/r2";
import { toClientAsset } from "../../core/assets/client";

/* ──────────────── Validation schemas ──────────────── */

const createGenerationSchema = z.object({
	filter_id: z.string().uuid(),
	input_asset_id: z.string().uuid(),
	params: z.record(z.unknown()).optional().default({}),
});

const listGenerationsQuery = paginationQuery.extend({
	status: z.string().optional(),
});

/* ──────────────── Helpers ──────────────── */

/** Strips provider-internal fields the mobile client should never see. */
function toClientJob(row: GenerationJobRow) {
	return {
		id: row.id,
		filter_id: row.filter_id,
		input_asset_id: row.input_asset_id,
		output_asset_id: row.output_asset_id,
		status: row.status,
		error_code: row.error_code,
		error_message: row.error_message,
		created_at: row.created_at,
		queued_at: row.queued_at,
		started_at: row.started_at,
		completed_at: row.completed_at,
		failed_at: row.failed_at,
	};
}

/* ──────────────── Router ──────────────── */

const generations = new Hono<AuthedEnv>();

// All generation routes require authentication
generations.use("/*", devAuth);

/**
 * POST /api/mobile/generations
 *
 * Submit a new generation job.
 * Validates the input asset, filter, and their compatibility,
 * creates a job record, then dispatches to the provider stub.
 */
generations.post("/", async (c) => {
	const body = await c.req.json();
	const data = createGenerationSchema.parse(body);
	const userId = c.get("userId");
	const db = c.env.DB;

	/* ── Verify input asset ── */
	const asset = await db
		.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?")
		.bind(data.input_asset_id, userId)
		.first<AssetRow>();

	if (!asset) {
		throw AppError.notFound("Input asset");
	}

	// Only uploaded assets can be used for generation
	if (asset.status !== "uploaded") {
		throw AppError.badRequest(
			"ASSET_NOT_READY",
			`Input asset is in '${asset.status}' status. Only 'uploaded' assets can be used for generation.`,
		);
	}

	// Must be an input asset
	if (asset.kind !== "input") {
		throw AppError.badRequest(
			"INVALID_ASSET_KIND",
			"Only input assets can be used for generation.",
		);
	}

	/* ── Verify filter ── */
	const filter = await db
		.prepare("SELECT * FROM filters WHERE id = ?")
		.bind(data.filter_id)
		.first<FilterRow>();

	if (!filter) {
		throw AppError.notFound("Filter");
	}

	if (!filter.is_active) {
		throw AppError.badRequest(
			"FILTER_INACTIVE",
			"This filter is currently not available.",
		);
	}

	// Check media type compatibility
	const acceptedTypes = filter.input_media_types.split(",").map((t) => t.trim());
	if (!acceptedTypes.includes(asset.type)) {
		throw AppError.badRequest(
			"MEDIA_TYPE_INCOMPATIBLE",
			`Filter '${filter.name}' does not accept '${asset.type}' input. Accepted: ${filter.input_media_types}.`,
		);
	}

	/* ── Create generation job ── */
	const jobId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO generation_jobs (
				id, user_id, filter_id, input_asset_id, status,
				requested_params_json, queued_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
		)
		.bind(
			jobId,
			userId,
			data.filter_id,
			data.input_asset_id,
			Object.keys(data.params).length > 0 ? JSON.stringify(data.params) : null,
			now,
			now,
			now,
		)
		.run();

	/* ── Dispatch to provider ── */
	const filterConfig = filter.config ? (JSON.parse(filter.config) as Record<string, unknown>) : null;
	const defaultParams = filter.default_params_json
		? (JSON.parse(filter.default_params_json) as Record<string, unknown>)
		: null;

	const inputImageUrl = await createPresignedReadUrl(c.env, asset.storage_key);

	let dispatchResult;
	try {
		dispatchResult = await dispatchGeneration(
			{
				jobId,
				filterModelId: filter.provider_model_id,
				filterConfig,
				inputStorageKey: asset.storage_key,
				inputMediaType: asset.type,
				params: data.params,
				providerName: filter.provider_name,
				prompt: filter.prompt_template,
				inputImageUrls: [inputImageUrl],
				defaultParams,
			},
			c.env,
		);
	} catch (err) {
		// Mark job as failed so it doesn't stay stuck in queued
		await db
			.prepare(
				`UPDATE generation_jobs SET
					status = 'failed', error_code = ?, error_message = ?,
					failed_at = ?, updated_at = ?
				WHERE id = ?`,
			)
			.bind(
				"DISPATCH_FAILED",
				err instanceof AppError ? err.message : "Generation dispatch failed",
				now,
				now,
				jobId,
			)
			.run();
		throw err;
	}

	// Update job with dispatch result
	await db
		.prepare(
			`UPDATE generation_jobs SET
				provider_name = ?,
				provider_job_id = ?,
				status = ?,
				started_at = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			dispatchResult.providerName,
			dispatchResult.providerJobId,
			dispatchResult.initialStatus,
			now,
			now,
			jobId,
		)
		.run();

	/* ── Return created job ── */
	const job = await db
		.prepare("SELECT * FROM generation_jobs WHERE id = ?")
		.bind(jobId)
		.first<GenerationJobRow>();

	return success(c, toClientJob(job!), 201);
});

/**
 * GET /api/mobile/generations/:id
 *
 * Return a single generation job. Enforces ownership.
 * For completed jobs with an output asset, includes a client-safe
 * output asset summary with a signed read URL.
 */
generations.get("/:id", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("userId");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM generation_jobs WHERE id = ? AND user_id = ?")
		.bind(id, userId)
		.first<GenerationJobRow>();

	if (!row) {
		throw AppError.notFound("Generation job");
	}

	let outputAsset = null;
	if (row.output_asset_id && row.status === "completed") {
		const assetRow = await db
			.prepare("SELECT * FROM assets WHERE id = ?")
			.bind(row.output_asset_id)
			.first<AssetRow>();
		if (assetRow) {
			outputAsset = await toClientAsset(assetRow, c.env);
		}
	}

	return success(c, { ...toClientJob(row), output_asset: outputAsset });
});

/**
 * GET /api/mobile/generations
 *
 * List the current user's generation jobs.
 * Supports pagination and optional status filtering.
 * Sorted newest first.
 */
generations.get("/", async (c) => {
	const query = parseQuery(c.req.url, listGenerationsQuery);
	const { page, pageSize } = query;
	const userId = c.get("userId");
	const db = c.env.DB;
	const offset = (page - 1) * pageSize;

	// Validate status filter if provided
	if (query.status && !isValidGenerationStatus(query.status)) {
		throw AppError.badRequest(
			"INVALID_STATUS_FILTER",
			`Invalid status '${query.status}'. Valid values: ${GENERATION_STATUSES.join(", ")}.`,
		);
	}

	const hasStatusFilter = !!query.status;
	const baseWhere = hasStatusFilter
		? "WHERE user_id = ? AND status = ?"
		: "WHERE user_id = ?";

	const bindValues = hasStatusFilter
		? [userId, query.status!]
		: [userId];

	const [rows, countResult] = await Promise.all([
		db
			.prepare(
				`SELECT * FROM generation_jobs ${baseWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
			)
			.bind(...bindValues, pageSize, offset)
			.all<GenerationJobRow>(),
		db
			.prepare(`SELECT COUNT(*) as total FROM generation_jobs ${baseWhere}`)
			.bind(...bindValues)
			.first<{ total: number }>(),
	]);

	const total = countResult?.total ?? 0;

	return paginated(c, rows.results.map(toClientJob), {
		page,
		pageSize,
		total,
		totalPages: Math.ceil(total / pageSize),
	});
});

export { generations as mobileGenerationRoutes };
