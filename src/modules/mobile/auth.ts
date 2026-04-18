import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../bindings";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success } from "../../shared/api-response";
import { AppError } from "../../shared/errors";
import { bootstrapAuth } from "../../core/auth/bootstrap";
import { hashToken, revokeSessionByTokenHash } from "../../core/auth/sessions";
import type { UserRow } from "../../core/db/schema";
import { checkRateLimit } from "../../lib/rate-limit";
import { trackEvent, extractRequestContext } from "../../core/tracking/tracker";

/* ──────────────── Validation ──────────────── */

const bootstrapSchema = z.object({
	installation_id: z.string().min(1).max(255),
	platform: z.enum(["ios", "android"]),
	app_version: z.string().min(1).max(50),
	device_identifier: z.string().max(255).optional(),
	device_model: z.string().max(255).optional(),
	os_version: z.string().max(50).optional(),
});

/* ──────────────── Public (unauthenticated) routes ──────────────── */

const publicRoutes = new Hono<AppEnv>();

/**
 * POST /api/mobile/auth/bootstrap
 *
 * Anonymous auth bootstrap. The first call the mobile app makes on launch.
 * Creates or recovers an anonymous user, registers the device, and returns
 * a session token the client uses for all subsequent requests.
 */
publicRoutes.post("/bootstrap", async (c) => {
	// Rate limit: 10 bootstrap requests per IP per 60 seconds
	const clientIp = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";
	const rl = checkRateLimit("bootstrap", clientIp, { maxRequests: 10, windowSeconds: 60 });
	if (!rl.allowed) {
		console.warn(`[security:rate-limit] Bootstrap rate limited: ip=${clientIp}`);
		throw AppError.tooManyRequests("Too many bootstrap requests. Please try again later.");
	}

	const body = await c.req.json();
	const data = bootstrapSchema.parse(body);
	const result = await bootstrapAuth(c.env.DB, data);

	// Track bootstrap — fire-and-forget, never throws
	await trackEvent(c.env.DB, "auth_bootstrap", {
		user_id: result.user.id,
		ctx: extractRequestContext(c.req),
		platform: data.platform,
		app_version: data.app_version,
		metadata: {
			installation_id: data.installation_id,
			device_identifier: data.device_identifier ?? null,
			recovered: result.recovery.recovered,
			recovery_method: result.recovery.method,
		},
	});

	return success(c, result);
});

/* ──────────────── Protected routes ──────────────── */

const protectedRoutes = new Hono<AuthedEnv>();
protectedRoutes.use("/*", requireAuth);

/**
 * GET /api/mobile/auth/me
 *
 * Returns the current authenticated user's basic info.
 */
protectedRoutes.get("/me", async (c) => {
	const userId = c.get("userId");
	const db = c.env.DB;

	const user = await db
		.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'")
		.bind(userId)
		.first<UserRow>();

	if (!user) {
		throw AppError.notFound("User");
	}

	return success(c, {
		id: user.id,
		is_anonymous: user.is_anonymous === 1,
		created_at: user.created_at,
	});
});

/**
 * POST /api/mobile/auth/logout
 *
 * Revokes the current session token.
 */
protectedRoutes.post("/logout", async (c) => {
	const authHeader = c.req.header("Authorization")!;
	const token = authHeader.slice(7).trim();
	const tokenHash = await hashToken(token);
	await revokeSessionByTokenHash(c.env.DB, tokenHash);
	return success(c, { message: "Logged out" });
});

/* ──────────────── Combined router ──────────────── */

const auth = new Hono<AppEnv>();
auth.route("/", publicRoutes);
auth.route("/", protectedRoutes);

export { auth as mobileAuthRoutes };
