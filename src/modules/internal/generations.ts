import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success } from "../../shared/api-response";
import { syncGenerationJob, syncPendingJobs } from "../../core/generation/sync";

// Internal routes are service-to-service (not client-facing).
// In production, secure with a shared secret header or Cloudflare Access.
const internalGenerations = new Hono<AppEnv>();

/**
 * POST /api/internal/generations/sync-pending
 *
 * Trigger a batch sync of all pending generation jobs.
 * Useful for manual triggering or external orchestration.
 *
 * Must be registered BEFORE /:id/sync — otherwise "sync-pending"
 * would be captured as an :id parameter by Hono's route matching.
 */
internalGenerations.post("/sync-pending", async (c) => {
	const result = await syncPendingJobs(c.env);
	return success(c, result);
});

/**
 * POST /api/internal/generations/:id/sync
 *
 * Trigger a status sync for a single generation job.
 * Polls the provider for current status, updates the job in D1,
 * and on completion fetches the output and stores it in R2.
 */
internalGenerations.post("/:id/sync", async (c) => {
	const jobId = c.req.param("id");
	const result = await syncGenerationJob(jobId, c.env);
	return success(c, result);
});

export { internalGenerations as internalGenerationRoutes };
