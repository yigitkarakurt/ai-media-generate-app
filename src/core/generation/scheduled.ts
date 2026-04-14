import type { AppBindings } from "../../bindings";
import { syncPendingJobs } from "./sync";

/**
 * Cloudflare Workers scheduled event handler.
 *
 * Triggered by the cron trigger configured in wrangler.jsonc.
 * Runs two maintenance tasks:
 * 1. Sync a batch of non-terminal generation jobs with their providers
 * 2. Clean up stale pending assets that were never confirmed
 */
export async function handleScheduled(
	_event: ScheduledEvent,
	env: AppBindings,
	_ctx: ExecutionContext,
): Promise<void> {
	console.log("[scheduled] Batch sync triggered");

	const result = await syncPendingJobs(env);

	console.log(
		`[scheduled] Batch sync complete: ${result.synced} synced, ` +
		`${result.completed} completed, ${result.failed} failed, ` +
		`${result.unchanged} unchanged`,
	);

	if (result.errors.length > 0) {
		console.error("[scheduled] Sync errors:", JSON.stringify(result.errors));
	}

	// Clean up stale pending assets (older than 1 hour)
	await cleanupStalePendingAssets(env);
}

/* ──────────────── Stale pending asset cleanup ──────────────── */

/** Threshold for considering a pending asset stale (1 hour) */
const STALE_PENDING_THRESHOLD_MINUTES = 60;

/**
 * Remove pending assets that were never confirmed.
 *
 * When a client requests an upload URL but never completes the
 * upload + confirm flow, the pending asset row lingers in D1.
 * The R2 presigned URL has already expired, so the object may
 * or may not exist in R2.
 *
 * This cleanup:
 * 1. Finds pending assets older than STALE_PENDING_THRESHOLD_MINUTES
 * 2. Attempts to delete the R2 object (best-effort, may not exist)
 * 3. Deletes the D1 row
 *
 * Only processes a bounded batch per run to avoid timeout.
 */
async function cleanupStalePendingAssets(env: AppBindings): Promise<void> {
	const db = env.DB;
	const bucket = env.MEDIA_BUCKET;

	const cutoff = new Date(
		Date.now() - STALE_PENDING_THRESHOLD_MINUTES * 60 * 1000,
	).toISOString();

	// Find stale pending assets (batch of 50 to stay within execution limits)
	const staleAssets = await db
		.prepare(
			`SELECT id, storage_key FROM assets
			 WHERE status = 'pending' AND created_at < ?
			 ORDER BY created_at ASC
			 LIMIT 50`,
		)
		.bind(cutoff)
		.all<{ id: string; storage_key: string }>();

	if (staleAssets.results.length === 0) {
		return;
	}

	console.log(`[scheduled:cleanup] Found ${staleAssets.results.length} stale pending assets`);

	let deleted = 0;
	let r2Deleted = 0;
	let r2Errors = 0;

	for (const asset of staleAssets.results) {
		// Best-effort R2 cleanup (object may not exist if upload was never started)
		try {
			await bucket.delete(asset.storage_key);
			r2Deleted++;
		} catch (err) {
			// R2 delete failures are non-fatal — the presigned URL has already expired
			r2Errors++;
			console.warn(`[scheduled:cleanup] R2 delete failed for ${asset.storage_key}:`, err);
		}

		// Delete D1 record
		await db
			.prepare("DELETE FROM assets WHERE id = ? AND status = 'pending'")
			.bind(asset.id)
			.run();
		deleted++;
	}

	console.log(
		`[scheduled:cleanup] Cleanup complete: ${deleted} assets deleted, ` +
		`${r2Deleted} R2 objects removed, ${r2Errors} R2 errors`,
	);
}
