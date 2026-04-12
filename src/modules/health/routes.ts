import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success } from "../../shared/api-response";

const VERSION = "0.1.0";

const health = new Hono<AppEnv>();

health.get("/health", (c) => {
	return success(c, {
		status: "ok",
		timestamp: new Date().toISOString(),
	});
});

health.get("/version", (c) => {
	return success(c, {
		version: VERSION,
		environment: c.env.ENVIRONMENT ?? "development",
	});
});

export { health as healthRoutes };
