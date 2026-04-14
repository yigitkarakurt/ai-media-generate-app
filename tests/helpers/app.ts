import { env, exports as rawWorkerExports } from "cloudflare:workers";
import type { RCWebhookPayload } from "../../src/core/billing/types";
import type { ErrorResponse, SuccessResponse } from "../../src/shared/api-response";

const BASE_URL = "http://local.test";
const workerExports = rawWorkerExports as unknown as {
	default: { fetch: typeof fetch };
};

interface RequestOptions extends Omit<RequestInit, "body"> {
	body?: BodyInit | object;
}

export function adminHeaders(init?: HeadersInit): Headers {
	const headers = new Headers(init);
	headers.set("X-Admin-Key", env.ADMIN_API_KEY);
	return headers;
}

export function internalHeaders(init?: HeadersInit): Headers {
	const headers = new Headers(init);
	headers.set("X-Internal-Key", env.INTERNAL_API_KEY);
	return headers;
}

export function authHeaders(token: string, init?: HeadersInit): Headers {
	const headers = new Headers(init);
	headers.set("Authorization", `Bearer ${token}`);
	return headers;
}

export async function appFetch(path: string, options: RequestOptions = {}) {
	const headers = new Headers(options.headers);
	let body = options.body as BodyInit | object | undefined;

	if (body && typeof body === "object" && !(body instanceof FormData)) {
		headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
		body = JSON.stringify(body);
	}

	return workerExports.default.fetch(`${BASE_URL}${path}`, {
		...options,
		headers,
		body: body as BodyInit | undefined,
	});
}

export async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

export async function successJson<T>(response: Response): Promise<SuccessResponse<T>> {
	return json<SuccessResponse<T>>(response);
}

export async function errorJson(response: Response): Promise<ErrorResponse> {
	return json<ErrorResponse>(response);
}

export function revenueCatHeaders(init?: HeadersInit): Headers {
	const headers = new Headers(init);
	headers.set("Authorization", `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`);
	headers.set("Content-Type", "application/json");
	return headers;
}

export function postRevenueCatWebhook(payload: RCWebhookPayload) {
	return appFetch("/api/webhooks/revenuecat", {
		method: "POST",
		headers: revenueCatHeaders(),
		body: payload,
	});
}
