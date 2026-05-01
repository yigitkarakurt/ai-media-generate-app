import { createMiddleware } from "hono/factory";
import type { AppBindings, AppEnv } from "../bindings";
import { AppError } from "../shared/errors";

const ADMIN_CORS_ALLOWED_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];
const ADMIN_CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-Admin-Key", "X-Internal-Key"];
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizeOrigin(origin: string): string {
	return origin.trim().replace(/\/+$/, "");
}

function getConfiguredAdminOrigins(env: AppBindings): Set<string> {
	return new Set(
		(env.ADMIN_PANEL_ORIGIN ?? "")
			.split(",")
			.map((origin) => normalizeOrigin(origin))
			.filter(Boolean),
	);
}

function isLocalDevelopmentOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return LOCALHOST_HOSTNAMES.has(url.hostname);
	} catch {
		return false;
	}
}

function isAdminOriginAllowed(origin: string, env: AppBindings): boolean {
	const normalizedOrigin = normalizeOrigin(origin);
	const configuredOrigins = getConfiguredAdminOrigins(env);

	if (configuredOrigins.has(normalizedOrigin)) {
		return true;
	}

	return env.ENVIRONMENT !== "production" && isLocalDevelopmentOrigin(normalizedOrigin);
}

function appendVaryHeader(headers: Headers, value: string) {
	const existing = headers.get("Vary");

	if (!existing) {
		headers.set("Vary", value);
		return;
	}

	const values = existing.split(",").map((item) => item.trim());
	if (!values.includes(value)) {
		headers.set("Vary", `${existing}, ${value}`);
	}
}

function applyAdminCorsHeaders(headers: Headers, origin: string) {
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Access-Control-Allow-Methods", ADMIN_CORS_ALLOWED_METHODS.join(", "));
	headers.set("Access-Control-Allow-Headers", ADMIN_CORS_ALLOWED_HEADERS.join(", "));
	headers.set("Access-Control-Max-Age", "86400");
	appendVaryHeader(headers, "Origin");
}

function getAllowedOriginOrThrow(origin: string | undefined, env: AppBindings): string | null {
	if (!origin) {
		return null;
	}

	const normalizedOrigin = normalizeOrigin(origin);

	if (!isAdminOriginAllowed(normalizedOrigin, env)) {
		throw AppError.forbidden("Origin not allowed");
	}

	return normalizedOrigin;
}

export const adminCors = createMiddleware<AppEnv>(async (c, next) => {
	const allowedOrigin = getAllowedOriginOrThrow(c.req.header("Origin"), c.env);

	await next();

	if (allowedOrigin) {
		applyAdminCorsHeaders(c.res.headers, allowedOrigin);
	}
});

export const handleAdminPreflight = createMiddleware<AppEnv>(async (c) => {
	const allowedOrigin = getAllowedOriginOrThrow(c.req.header("Origin"), c.env);

	if (allowedOrigin) {
		applyAdminCorsHeaders(c.res.headers, allowedOrigin);
		appendVaryHeader(c.res.headers, "Access-Control-Request-Method");
		appendVaryHeader(c.res.headers, "Access-Control-Request-Headers");
	}

	return c.body(null, 204);
});
