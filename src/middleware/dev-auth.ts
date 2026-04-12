import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";

/**
 * Temporary dev auth middleware.
 * In development: accepts X-Dev-User-Id header to set the user context.
 * In production: this MUST be replaced with real JWT auth — the header is rejected.
 *
 * Sets c.set("userId", ...) for downstream handlers.
 */
export const devAuth = createMiddleware<
	AppEnv & { Variables: { userId: string } }
>(async (c, next) => {
	const devUserId = c.req.header("X-Dev-User-Id");

	if (devUserId) {
		if (c.env.ENVIRONMENT === "production") {
			return c.json(
				{ success: false, error: { code: "FORBIDDEN", message: "Dev auth not allowed in production" } },
				403,
			);
		}
		c.set("userId", devUserId);
		return next();
	}

	// No auth header provided — reject
	return c.json(
		{ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
		401,
	);
});

/**
 * Extended Hono env that includes the userId variable set by auth middleware.
 */
export interface AuthedEnv extends AppEnv {
	Variables: { userId: string };
}
