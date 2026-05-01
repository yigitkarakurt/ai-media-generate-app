import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success, paginated } from "../../shared/api-response";
import { parseQuery, paginationQuery } from "../../shared/validation";
import { AppError } from "../../shared/errors";
import type { GenerationJobRow, AssetRow, FilterRow } from "../../core/db/schema";
import { GENERATION_STATUSES, isValidGenerationStatus } from "../../core/generation/types";
import { dispatchGeneration } from "../../core/generation/dispatch";
import { createPresignedReadUrl } from "../../lib/r2";
import { toClientAsset } from "../../core/assets/client";
import { createGenerationDebit, refundGenerationDebit } from "../../core/billing/queries";
import { atomicDebit, ensureWallet, getWalletBalance, creditWallet } from "../../core/billing/wallet";
import { checkRateLimit } from "../../lib/rate-limit";
import { trackEvent, extractRequestContext } from "../../core/tracking/tracker";

/* ──────────────── Validation schemas ──────────────── */

/**
 * Generation create request shape.
 *
 * - filter_id:       required — which filter/effect to apply
 * - input_asset_ids: preferred plural form; provide one or more asset IDs
 * - input_asset_id:  legacy singular form; normalized to input_asset_ids[0]
 * - user_prompt:     MUST NOT be provided — filter prompts are backend-owned
 * - params:          optional extra params (passed through to provider)
 *
 * Backward compatibility: clients that still send input_asset_id will continue
 * to work. The singular value is normalized to input_asset_ids[0] internally.
 */
const createGenerationSchema = z
	.object({
		filter_id: z.string().uuid(),
		// Preferred plural form
		input_asset_ids: z.array(z.string().uuid()).min(1).optional(),
		// Legacy singular form — kept for backward compat
		input_asset_id: z.string().uuid().optional(),
		// User-supplied prompts are never allowed for filter generation.
		// This field is declared so we can give a clear error if it appears.
		user_prompt: z.never({
			errorMap: () => ({
				message: "user_prompt must not be provided for filter generation. Prompts are backend-owned.",
			}),
		}).optional(),
		params: z.record(z.unknown()).optional().default({}),
	})
	.superRefine((val, ctx) => {
		// At least one of input_asset_ids or input_asset_id must be provided
		if (!val.input_asset_ids?.length && !val.input_asset_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["input_asset_ids"],
				message: "At least one input asset is required. Provide input_asset_ids or input_asset_id.",
			});
		}
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
generations.use("/*", requireAuth);

/**
 * POST /api/mobile/generations
 *
 * Submit a new generation job for a filter/effect template.
 *
 * The prompt is always sourced from the filter's backend-controlled
 * prompt_template. The client must never supply or override the prompt.
 *
 * Validates:
 * - user_prompt must not be present
 * - input asset(s) provided and owned by user
 * - asset count within filter's min/max_media_count
 * - asset type matches filter's input_media_type
 * - filter is active and has a valid prompt_template
 */
generations.post("/", async (c) => {
	const userId = c.get("userId");
	const db = c.env.DB;

	// Rate limit: 5 generation requests per user per 60 seconds
	const rl = checkRateLimit("generation", userId, { maxRequests: 5, windowSeconds: 60 });
	if (!rl.allowed) {
		console.warn(`[security:rate-limit] Generation rate limited: user=${userId}`);
		throw AppError.tooManyRequests("Too many generation requests. Please try again later.");
	}

	// ── Parse and validate body ──
	const rawBody = await c.req.json() as Record<string, unknown>;

	// Explicit early rejection of user_prompt before schema parsing
	// gives a clean, descriptive error code rather than a Zod parse error.
	if ("user_prompt" in rawBody) {
		throw AppError.badRequest(
			"PROMPT_NOT_ALLOWED",
			"user_prompt must not be provided for filter generation. Filter prompts are owned by the backend.",
		);
	}

	const parseResult = createGenerationSchema.safeParse(rawBody);
	if (!parseResult.success) {
		const firstIssue = parseResult.error.issues[0];
		const path = firstIssue.path.join(".");
		const isAssetMissing = path === "input_asset_ids";

		throw AppError.badRequest(
			isAssetMissing ? "MISSING_INPUT_ASSETS" : "VALIDATION_ERROR",
			firstIssue.message,
		);
	}
	const data = parseResult.data;

	// Normalize: singular input_asset_id → input_asset_ids[0]
	const assetIds: string[] = data.input_asset_ids?.length
		? data.input_asset_ids
		: [data.input_asset_id!];

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

	// Reject if the filter has no backend prompt (invalid filter config)
	if (!filter.prompt_template || filter.prompt_template.trim() === "") {
		console.error(`[generation] Filter ${filter.id} (${filter.slug}) has no prompt_template`);
		throw AppError.internal("This filter is not properly configured.");
	}

	// Reject text_to_image / text_to_video — these are not filter operations
	if (filter.operation_type === "text_to_image" || filter.operation_type === "text_to_video") {
		console.error(`[generation] Filter ${filter.id} has unsupported operation_type=${filter.operation_type}`);
		throw AppError.internal("This filter is not properly configured.");
	}

	/* ── Validate asset count ── */
	const minCount = filter.min_media_count ?? 1;
	const maxCount = filter.max_media_count ?? 1;

	if (assetIds.length < minCount) {
		throw AppError.badRequest(
			"MISSING_INPUT_ASSETS",
			`This filter requires at least ${minCount} input asset(s). Provided: ${assetIds.length}.`,
		);
	}

	if (assetIds.length > maxCount) {
		throw AppError.badRequest(
			"TOO_MANY_INPUT_ASSETS",
			`This filter accepts at most ${maxCount} input asset(s). Provided: ${assetIds.length}.`,
		);
	}

	/* ── Verify all input assets ── */
	const assets: AssetRow[] = [];
	const expectedMediaType = filter.input_media_type || "image";

	for (const assetId of assetIds) {
		const asset = await db
			.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?")
			.bind(assetId, userId)
			.first<AssetRow>();

		if (!asset) {
			throw AppError.notFound(`Input asset (${assetId})`);
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

		// Asset type must match filter's required input_media_type
		if (asset.type !== expectedMediaType) {
			throw AppError.badRequest(
				"MEDIA_TYPE_INCOMPATIBLE",
				`Filter '${filter.name}' requires '${expectedMediaType}' input, but asset is '${asset.type}'.`,
			);
		}

		assets.push(asset);
	}

	// Primary asset (first) is used for dispatch; multi-asset dispatch is deferred
	const primaryAsset = assets[0];

	/* ── Atomic coin debit ── */
	const coinCost = filter.coin_cost ?? 0;
	if (coinCost > 0) {
		// Ensure wallet exists for this user
		await ensureWallet(db, userId);

		// Atomic debit: UPDATE WHERE balance >= cost (prevents concurrent overspend)
		const debited = await atomicDebit(db, userId, coinCost);
		if (!debited) {
			const currentBalance = await getWalletBalance(db, userId);
			console.warn(`[security:billing] Insufficient coins: user=${userId}, cost=${coinCost}, balance=${currentBalance}`);
			throw AppError.badRequest(
				"INSUFFICIENT_COINS",
				`This generation costs ${coinCost} coins but your balance is ${currentBalance}.`,
			);
		}
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
			primaryAsset.id,
			Object.keys(data.params).length > 0 ? JSON.stringify(data.params) : null,
			now,
			now,
			now,
		)
		.run();

	/* ── Append ledger entry for audit trail (wallet already debited) ── */
	if (coinCost > 0) {
		await createGenerationDebit(db, userId, coinCost, jobId);
	}

	/* ── Dispatch to provider ── */
	const filterConfig = filter.config ? (JSON.parse(filter.config) as Record<string, unknown>) : {};
	const modelKey = filter.model_key || filter.provider_model_id;
	const operationType = filter.operation_type
		|| (typeof filterConfig.operation_type === "string" ? filterConfig.operation_type : undefined);

	// Reject unsupported operation types at dispatch time
	if (operationType === "image_to_video") {
		// image_to_video is supported in the catalog schema but provider dispatch
		// may not yet be implemented. Let the provider return an error naturally
		// rather than silently skipping — this gives a clean failure.
		console.log(`[generation] image_to_video dispatch for job ${jobId} via provider ${filter.provider_name}`);
	}

	const dispatchConfig = {
		...filterConfig,
		model_key: modelKey,
		...(operationType ? { operation_type: operationType } : {}),
	};
	const defaultParams = filter.default_params_json
		? (JSON.parse(filter.default_params_json) as Record<string, unknown>)
		: null;

	const inputImageUrl = await createPresignedReadUrl(c.env, primaryAsset.storage_key);
	// Build URLs for all assets; providers that support multi-image can use the full list.
	// For now dispatch uses inputImageUrls[0].
	const allInputUrls = await Promise.all(
		assets.map((a) => createPresignedReadUrl(c.env, a.storage_key)),
	);

	let dispatchResult;
	try {
		dispatchResult = await dispatchGeneration(
			{
				jobId,
				filterModelId: modelKey,
				filterConfig: dispatchConfig,
				inputStorageKey: primaryAsset.storage_key,
				inputMediaType: primaryAsset.type,
				params: data.params,
				providerName: filter.provider_name,
				prompt: filter.prompt_template,
				inputImageUrls: allInputUrls,
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

		// Refund debited coins on dispatch failure (wallet + ledger)
		if (coinCost > 0) {
			await creditWallet(db, userId, coinCost);
			await refundGenerationDebit(db, userId, coinCost, jobId);
		}

		throw err;
	}

	// Update job with dispatch result.
	// Synchronous providers (e.g. OpenRouter) may return outputAssetId and
	// initialStatus="completed" — in that case we write output_asset_id and
	// completed_at in the same UPDATE so the job is immediately terminal.
	if (dispatchResult.outputAssetId) {
		await db
			.prepare(
				`UPDATE generation_jobs SET
					provider_name = ?,
					provider_job_id = ?,
					status = ?,
					output_asset_id = ?,
					started_at = ?,
					completed_at = ?,
					updated_at = ?
				WHERE id = ?`,
			)
			.bind(
				dispatchResult.providerName,
				dispatchResult.providerJobId,
				dispatchResult.initialStatus,
				dispatchResult.outputAssetId,
				now,
				now,
				now,
				jobId,
			)
			.run();
	} else {
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
	}

	/* ── Return created job ── */
	const job = await db
		.prepare("SELECT * FROM generation_jobs WHERE id = ?")
		.bind(jobId)
		.first<GenerationJobRow>();

	// Track generation created — fire-and-forget, never throws
	await trackEvent(c.env.DB, "generation_created", {
		user_id: userId,
		ctx: extractRequestContext(c.req),
		metadata: {
			generation_id: jobId,
			filter_id: data.filter_id,
			provider_name: dispatchResult.providerName,
			operation_type: operationType ?? null,
		},
	});

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
