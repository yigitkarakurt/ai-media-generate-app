import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";
import { AppError } from "../shared/errors";
import { validateSession, touchSession } from "../core/auth/sessions";

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
 * In non-production environments, also accepts the legacy X-Dev-User-Id
 * header for backward compatibility with development tooling (Postman, etc).
 */
export const requireAuth = createMiddleware<AuthedEnv>(async (c, next) => {
	// Dev auth fallback — non-production only
	if (c.env.ENVIRONMENT !== "production") {
		const devUserId = c.req.header("X-Dev-User-Id");
		if (devUserId) {
			c.set("userId", devUserId);
			return next();
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
