import { Hono } from "hono";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success } from "../../shared/api-response";

const devices = new Hono<AuthedEnv>();

// All device routes require authentication
devices.use("/*", requireAuth);

/** Register a push notification token */
devices.post("/push-token", async (c) => {
	// Will be implemented with push notification integration.
	// Needs: token validation, upsert logic.
	return success(c, { message: "Push token registration not yet implemented" }, 501 as any);
});

/** Remove a push notification token */
devices.delete("/push-token", async (c) => {
	// Will deactivate the token for the authenticated user.
	return success(c, { message: "Push token removal not yet implemented" }, 501 as any);
});

export { devices as mobileDeviceRoutes };
