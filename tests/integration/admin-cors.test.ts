import { beforeEach, describe, expect, it } from "vitest";
import { appFetch, errorJson } from "../helpers/app";
import { resetTestDatabase } from "../helpers/db";

const ADMIN_PANEL_ORIGIN = "https://ai-media-generate-admin.pages.dev";

describe("admin cors integration", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("answers allowed admin preflight requests without requiring admin auth", async () => {
		const response = await appFetch("/api/admin/billing/products", {
			method: "OPTIONS",
			headers: {
				Origin: ADMIN_PANEL_ORIGIN,
				"Access-Control-Request-Method": "PATCH",
				"Access-Control-Request-Headers": "Content-Type, X-Admin-Key",
			},
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ADMIN_PANEL_ORIGIN);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Admin-Key");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Internal-Key");
	});

	it("rejects admin preflight from origins outside the allowlist", async () => {
		const response = await appFetch("/api/admin/billing/products", {
			method: "OPTIONS",
			headers: {
				Origin: "https://evil.example",
				"Access-Control-Request-Method": "GET",
			},
		});
		const body = await errorJson(response);

		expect(response.status).toBe(403);
		expect(body.error.code).toBe("FORBIDDEN");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("keeps admin auth enforced on actual cross-origin requests", async () => {
		const response = await appFetch("/api/admin/billing/products", {
			headers: {
				Origin: ADMIN_PANEL_ORIGIN,
				"X-Admin-Key": "wrong-key",
			},
		});
		const body = await errorJson(response);

		expect(response.status).toBe(401);
		expect(body.error.code).toBe("UNAUTHORIZED");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ADMIN_PANEL_ORIGIN);
	});
});
