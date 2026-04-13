import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";
import { AppError } from "../shared/errors";

/**
 * Admin auth middleware.
 *
 * Validates the X-Admin-Key header against the ADMIN_API_KEY secret.
 * This is a simple shared-secret approach intended to be replaced with
 * role-based admin authentication later.
 *
 * In non-production environments, if ADMIN_API_KEY is not set the
 * middleware allows requests through (so dev doesn't require the secret).
 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
	const adminKey = c.env.ADMIN_API_KEY;

	// In development without a configured key, allow access
	if (!adminKey && c.env.ENVIRONMENT !== "production") {
		return next();
	}

	if (!adminKey) {
		throw AppError.internal("Admin auth not configured");
	}

	const providedKey = c.req.header("X-Admin-Key") ?? "";

	// Timing-safe comparison
	const encoder = new TextEncoder();
	const a = encoder.encode(providedKey);
	const b = encoder.encode(adminKey);

	if (a.byteLength !== b.byteLength) {
		throw AppError.unauthorized("Invalid admin credentials");
	}

	const isValid = await crypto.subtle.timingSafeEqual(a, b);
	if (!isValid) {
		throw AppError.unauthorized("Invalid admin credentials");
	}

	return next();
});
