import { beforeEach, describe, expect, it } from "vitest";
import { appFetch, errorJson, internalHeaders } from "../helpers/app";
import { resetTestDatabase } from "../helpers/db";

describe("internal route auth", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("rejects internal sync-pending without credentials", async () => {
		const response = await appFetch("/api/internal/generations/sync-pending", {
			method: "POST",
		});
		const body = await errorJson(response);

		expect(response.status).toBe(401);
		expect(body.error.code).toBe("UNAUTHORIZED");
	});

	it("rejects internal sync-pending with wrong credentials", async () => {
		const response = await appFetch("/api/internal/generations/sync-pending", {
			method: "POST",
			headers: { "X-Internal-Key": "wrong-key" },
		});
		const body = await errorJson(response);

		expect(response.status).toBe(401);
		expect(body.error.code).toBe("UNAUTHORIZED");
	});

	it("allows internal sync-pending with correct credentials", async () => {
		const response = await appFetch("/api/internal/generations/sync-pending", {
			method: "POST",
			headers: internalHeaders(),
		});

		// Should succeed (200) — no pending jobs to sync
		expect(response.status).toBe(200);
	});

	it("rejects single job sync without credentials", async () => {
		const response = await appFetch(
			"/api/internal/generations/some-job-id/sync",
			{ method: "POST" },
		);
		const body = await errorJson(response);

		expect(response.status).toBe(401);
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});
