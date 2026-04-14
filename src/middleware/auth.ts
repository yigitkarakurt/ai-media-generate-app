import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";
import { AppError } from "../shared/errors";
import { validateSession, touchSession } from "../core/auth/sessions";

/**
 * Environments where dev auth fallback is explicitly allowed.
 * Any ENVIRONMENT value not in this list is treated as production-grade.
 */
const DEV_AUTH_ALLOWED_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * Extended Hono env that includes the userId variable set by auth middleware.
 * This replaces the AuthedEnv previously exported from dev-auth.ts.
 */
export interface AuthedEnv extends AppEnv {
	Variables: { userId: string };
}

/**
 * Production auth middleware.
 *
 * Validates a Bearer token from the Authorization header against the
 * auth_sessions table in D1. Sets c.set("userId", ...) for downstream
 * handlers.
 *
 * Dev auth fallback (X-Dev-User-Id header) is only allowed when
 * ENVIRONMENT is explicitly set to "development" or "test".
 * If ENVIRONMENT is missing, empty, or any other value, the fallback
 * is NOT available — fail-closed.
 */
export const requireAuth = createMiddleware<AuthedEnv>(async (c, next) => {
	// Dev auth fallback — only in explicitly allowed environments
	const environment = c.env.ENVIRONMENT ?? "";
	if (DEV_AUTH_ALLOWED_ENVIRONMENTS.has(environment)) {
		const devUserId = c.req.header("X-Dev-User-Id");
		if (devUserId) {
			c.set("userId", devUserId);
			return next();
		}
	} else {
		// Log if someone tries dev auth in a non-dev environment
		const devUserId = c.req.header("X-Dev-User-Id");
		if (devUserId) {
			console.warn(
				`[security] X-Dev-User-Id header rejected in "${environment}" environment`,
			);
		}
	}

	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		throw AppError.unauthorized("Missing or invalid authorization header");
	}

	const token = authHeader.slice(7).trim();
	if (!token) {
		throw AppError.unauthorized("Empty bearer token");
	}

	const session = await validateSession(c.env.DB, token);
	if (!session) {
		throw AppError.unauthorized("Invalid or expired session");
	}

	// Update last_used_at in the background (non-blocking)
	c.executionCtx.waitUntil(touchSession(c.env.DB, session.sessionId));

	c.set("userId", session.userId);
	return next();
});
