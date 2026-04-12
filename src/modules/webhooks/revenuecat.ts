import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success } from "../../shared/api-response";
import { AppError } from "../../shared/errors";
import type { RCWebhookPayload } from "../../core/billing/types";
import { processRevenueCatEvent } from "../../core/billing/process-event";

const revenuecat = new Hono<AppEnv>();

/**
 * POST /api/webhooks/revenuecat
 *
 * Receives RevenueCat server-to-server webhook events.
 * Authenticated via shared secret in Authorization header.
 * Idempotent: duplicate events are safely skipped.
 */
revenuecat.post("/", async (c) => {
	// Verify webhook authentication
	const authHeader = c.req.header("Authorization") ?? "";
	const expectedToken = `Bearer ${c.env.REVENUECAT_WEBHOOK_SECRET}`;

	// Timing-safe comparison to prevent timing attacks on the secret
	const encoder = new TextEncoder();
	const a = encoder.encode(authHeader);
	const b = encoder.encode(expectedToken);

	if (a.byteLength !== b.byteLength) {
		throw AppError.unauthorized("Invalid webhook authorization");
	}

	const isValid = await crypto.subtle.timingSafeEqual(a, b);
	if (!isValid) {
		throw AppError.unauthorized("Invalid webhook authorization");
	}

	// Parse payload
	let payload: RCWebhookPayload;
	try {
		payload = await c.req.json();
	} catch {
		throw AppError.badRequest("INVALID_JSON", "Request body is not valid JSON");
	}

	if (!payload.event?.id || !payload.event?.type) {
		throw AppError.badRequest(
			"INVALID_PAYLOAD",
			"Missing required event fields (id, type)",
		);
	}

	// Process event
	const result = await processRevenueCatEvent(payload, c.env);

	console.log(
		`[webhook:revenuecat] Event ${payload.event.id} (${payload.event.type}): ${result.status}`,
	);

	return success(c, result);
});

export { revenuecat as revenuecatWebhookRoutes };
