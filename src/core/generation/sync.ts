import type { AppBindings } from "../../bindings";
import { AppError } from "../../shared/errors";
import { generateStorageKey } from "../../shared/media";
import type { GenerationJobRow } from "../db/schema";
import { getProvider } from "./providers";

/* ──────────────── Types ──────────────── */

export interface SyncResult {
	jobId: string;
	previousStatus: string;
	currentStatus: string;
	outputAssetId?: string;
	changed: boolean;
}

export interface BatchSyncResult {
	synced: number;
	completed: number;
	failed: number;
	unchanged: number;
	errors: Array<{ jobId: string; error: string }>;
}

/* ──────────────── Helpers ──────────────── */

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function extensionFromContentType(contentType: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/heic": "heic",
		"video/mp4": "mp4",
		"video/webm": "webm",
	};
	const base = contentType.split(";")[0].trim().toLowerCase();
	return map[base] ?? "png";
}

/* ──────────────── Sync logic ──────────────── */

/**
 * Sync a generation job with its provider.
 *
 * Polls the provider for the current status, updates the job in D1,
 * and on completion fetches the output and stores it in R2.
 *
 * Designed to be idempotent: calling it multiple times on the same job
 * is safe and produces the same end state.
 */
export async function syncGenerationJob(
	jobId: string,
	env: AppBindings,
): Promise<SyncResult> {
	const db = env.DB;

	/* ── Load job ── */
	const job = await db
		.prepare("SELECT * FROM generation_jobs WHERE id = ?")
		.bind(jobId)
		.first<GenerationJobRow>();

	if (!job) {
		throw AppError.notFound("Generation job");
	}

	const previousStatus = job.status;

	/* ── Guard: already terminal ── */
	if (TERMINAL_STATUSES.has(job.status)) {
		return { jobId, previousStatus, currentStatus: job.status, changed: false };
	}

	/* ── Guard: must have provider info ── */
	if (!job.provider_name || !job.provider_job_id) {
		throw AppError.badRequest(
			"MISSING_PROVIDER_INFO",
			"Job has no provider assignment",
		);
	}

	/* ── Resolve provider ── */
	const provider = getProvider(job.provider_name);
	if (!provider) {
		console.error(`[sync] No provider registered for "${job.provider_name}" (job ${jobId})`);
		throw AppError.internal("Generation service is not configured for this job");
	}

	/* ── Poll provider ── */
	const result = await provider.checkStatus(job.provider_job_id, env);
	const now = new Date().toISOString();

	/* ── Handle: still processing ── */
	if (result.status === "processing") {
		await db
			.prepare(
				`UPDATE generation_jobs SET
					provider_status = ?,
					started_at = COALESCE(started_at, ?),
					updated_at = ?
				WHERE id = ?`,
			)
			.bind(result.providerRawStatus, now, now, jobId)
			.run();

		return {
			jobId,
			previousStatus,
			currentStatus: "processing",
			changed: previousStatus !== "processing",
		};
	}

	/* ── Handle: failed ── */
	if (result.status === "failed") {
		await db
			.prepare(
				`UPDATE generation_jobs SET
					status = 'failed',
					provider_status = ?,
					error_code = ?,
					error_message = ?,
					failed_at = ?,
					updated_at = ?
				WHERE id = ?`,
			)
			.bind(
				result.providerRawStatus,
				"PROVIDER_FAILED",
				result.errorMessage ?? "Generation failed at provider",
				now,
				now,
				jobId,
			)
			.run();

		return { jobId, previousStatus, currentStatus: "failed", changed: true };
	}

	/* ── Handle: completed ── */

	// Idempotency: if output asset was already created (previous sync stored it
	// but failed to update the job), just finalize the job status.
	if (job.output_asset_id) {
		await db
			.prepare(
				`UPDATE generation_jobs SET
					status = 'completed',
					provider_status = ?,
					completed_at = ?,
					updated_at = ?
				WHERE id = ?`,
			)
			.bind(result.providerRawStatus, now, now, jobId)
			.run();

		return {
			jobId,
			previousStatus,
			currentStatus: "completed",
			outputAssetId: job.output_asset_id,
			changed: true,
		};
	}

	// Validate output URL
	if (!result.resultUrl) {
		console.error(`[sync] Provider completed but no output URL (job ${jobId})`);
		await markJobFailed(db, jobId, "OUTPUT_URL_MISSING", "Provider completed without output URL", now);
		return { jobId, previousStatus, currentStatus: "failed", changed: true };
	}

	// Fetch the output from the provider
	let outputResponse: Response;
	try {
		outputResponse = await fetch(result.resultUrl);
	} catch (err) {
		console.error(`[sync] Failed to fetch output (job ${jobId}):`, err);
		await markJobFailed(db, jobId, "OUTPUT_FETCH_FAILED", "Failed to download generation output", now);
		return { jobId, previousStatus, currentStatus: "failed", changed: true };
	}

	if (!outputResponse.ok) {
		console.error(`[sync] Output fetch returned ${outputResponse.status} (job ${jobId})`);
		await markJobFailed(db, jobId, "OUTPUT_FETCH_FAILED", `Output download failed with status ${outputResponse.status}`, now);
		return { jobId, previousStatus, currentStatus: "failed", changed: true };
	}

	// Determine content type and build storage key
	const contentType = outputResponse.headers.get("content-type") ?? "image/png";
	const ext = extensionFromContentType(contentType);
	const filename = `output_${jobId}.${ext}`;
	const outputAssetId = crypto.randomUUID();
	const storageKey = generateStorageKey("output", job.user_id, outputAssetId, filename);

	// Store in R2 first (if this fails, job stays processing and next sync retries)
	await env.MEDIA_BUCKET.put(storageKey, outputResponse.body, {
		httpMetadata: { contentType },
	});

	// Get actual file size from R2
	const headResult = await env.MEDIA_BUCKET.head(storageKey);
	const fileSize = headResult?.size ?? 0;

	// Determine media type from content type
	const mediaType = contentType.startsWith("video/") ? "video" : "image";

	// Create output asset record
	await db
		.prepare(
			`INSERT INTO assets (
				id, user_id, kind, type, status, storage_key,
				original_filename, mime_type, file_size_bytes,
				created_at, updated_at
			) VALUES (?, ?, 'output', ?, 'ready', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			outputAssetId,
			job.user_id,
			mediaType,
			storageKey,
			filename,
			contentType,
			fileSize,
			now,
			now,
		)
		.run();

	// Update job to completed with output asset link
	await db
		.prepare(
			`UPDATE generation_jobs SET
				status = 'completed',
				provider_status = ?,
				output_asset_id = ?,
				completed_at = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(result.providerRawStatus, outputAssetId, now, now, jobId)
		.run();

	return {
		jobId,
		previousStatus,
		currentStatus: "completed",
		outputAssetId,
		changed: true,
	};
}

/* ──────────────── Batch sync ──────────────── */

/**
 * Sync a bounded batch of non-terminal generation jobs.
 *
 * Selects jobs in queued/processing state that have provider info,
 * ordered by least recently updated (natural sync priority).
 * Calls syncGenerationJob() for each, catching per-job errors.
 */
export async function syncPendingJobs(
	env: AppBindings,
	batchSize = 10,
): Promise<BatchSyncResult> {
	const db = env.DB;

	const rows = await db
		.prepare(
			`SELECT id FROM generation_jobs
			WHERE status IN ('queued', 'processing')
				AND provider_name IS NOT NULL
				AND provider_job_id IS NOT NULL
			ORDER BY updated_at ASC
			LIMIT ?`,
		)
		.bind(batchSize)
		.all<{ id: string }>();

	const result: BatchSyncResult = {
		synced: 0,
		completed: 0,
		failed: 0,
		unchanged: 0,
		errors: [],
	};

	// Process sequentially to avoid overwhelming provider APIs
	for (const row of rows.results) {
		try {
			const syncResult = await syncGenerationJob(row.id, env);
			result.synced++;
			if (syncResult.currentStatus === "completed") result.completed++;
			else if (syncResult.currentStatus === "failed") result.failed++;
			else if (!syncResult.changed) result.unchanged++;
		} catch (err) {
			result.synced++;
			result.errors.push({
				jobId: row.id,
				error: err instanceof Error ? err.message : "Unknown sync error",
			});
		}
	}

	return result;
}

/* ──────────────── Internal helpers ──────────────── */

async function markJobFailed(
	db: D1Database,
	jobId: string,
	errorCode: string,
	errorMessage: string,
	now: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE generation_jobs SET
				status = 'failed',
				error_code = ?,
				error_message = ?,
				failed_at = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(errorCode, errorMessage, now, now, jobId)
		.run();
}
