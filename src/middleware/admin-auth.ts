import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";
import { AppError } from "../shared/errors";

/**
 * Environments where admin auth can be skipped (when ADMIN_API_KEY is unset).
 * Any ENVIRONMENT value not in this list requires a configured key.
 */
const ADMIN_DEV_ALLOWED_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * Admin auth middleware.
 *
 * Validates the X-Admin-Key header against the ADMIN_API_KEY secret.
 * This is a simple shared-secret approach intended to be replaced with
 * role-based admin authentication later.
 *
 * Dev fallback (skip auth when key is unset) is only allowed when
 * ENVIRONMENT is explicitly set to "development" or "test".
 * If ENVIRONMENT is missing, empty, or any other value (including
 * "production"), a configured ADMIN_API_KEY is always required.
 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
	const adminKey = c.env.ADMIN_API_KEY;
	const environment = c.env.ENVIRONMENT ?? "";

	// Dev fallback: only skip auth if key is unset AND environment is explicitly dev/test
	if (!adminKey && ADMIN_DEV_ALLOWED_ENVIRONMENTS.has(environment)) {
		return next();
	}

	if (!adminKey) {
		console.error(`[security] ADMIN_API_KEY is not configured in "${environment}" environment — rejecting admin request`);
		throw AppError.internal("Admin auth not configured");
	}

	const providedKey = c.req.header("X-Admin-Key") ?? "";

	if (!providedKey) {
		console.warn("[security] Admin route access denied: missing X-Admin-Key header");
		throw AppError.unauthorized("Invalid admin credentials");
	}

	// Timing-safe comparison
	const encoder = new TextEncoder();
	const a = encoder.encode(providedKey);
	const b = encoder.encode(adminKey);

	if (a.byteLength !== b.byteLength) {
		console.warn("[security] Admin route access denied: invalid credentials");
		throw AppError.unauthorized("Invalid admin credentials");
	}

	const isValid = await crypto.subtle.timingSafeEqual(a, b);
	if (!isValid) {
		console.warn("[security] Admin route access denied: invalid credentials");
		throw AppError.unauthorized("Invalid admin credentials");
	}

	return next();
});
