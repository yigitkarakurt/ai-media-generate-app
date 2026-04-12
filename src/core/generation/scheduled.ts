import type { AppBindings } from "../../bindings";
import { syncPendingJobs } from "./sync";

/**
 * Cloudflare Workers scheduled event handler.
 *
 * Triggered by the cron trigger configured in wrangler.jsonc.
 * Syncs a batch of non-terminal generation jobs with their providers.
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
}
