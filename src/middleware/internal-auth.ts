import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";
import { AppError } from "../shared/errors";

/**
 * Internal route auth middleware.
 *
 * Validates the X-Internal-Key header against the INTERNAL_API_KEY secret.
 * Used for service-to-service routes (e.g. generation sync) that should
 * not be callable by untrusted clients.
 *
 * Fail-closed: if INTERNAL_API_KEY is not configured, all requests are
 * rejected regardless of environment.
 */
export const requireInternal = createMiddleware<AppEnv>(async (c, next) => {
	const internalKey = c.env.INTERNAL_API_KEY;

	// Fail-closed: always require the key, even in development
	if (!internalKey) {
		console.error("[security] INTERNAL_API_KEY is not configured — rejecting internal request");
		throw AppError.internal("Internal auth not configured");
	}

	const providedKey = c.req.header("X-Internal-Key") ?? "";

	if (!providedKey) {
		console.warn("[security] Internal route access denied: missing X-Internal-Key header");
		throw AppError.unauthorized("Internal authentication required");
	}

	// Timing-safe comparison
	const encoder = new TextEncoder();
	const a = encoder.encode(providedKey);
	const b = encoder.encode(internalKey);

	if (a.byteLength !== b.byteLength) {
		console.warn("[security] Internal route access denied: invalid credentials");
		throw AppError.unauthorized("Invalid internal credentials");
	}

	const isValid = await crypto.subtle.timingSafeEqual(a, b);
	if (!isValid) {
		console.warn("[security] Internal route access denied: invalid credentials");
		throw AppError.unauthorized("Invalid internal credentials");
	}

	return next();
});
