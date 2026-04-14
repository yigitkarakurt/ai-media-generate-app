import { beforeEach, describe, expect, it } from "vitest";
import { appFetch, errorJson } from "../helpers/app";
import { resetTestDatabase } from "../helpers/db";
import { resetAllRateLimits } from "../../src/lib/rate-limit";

describe("security hardening pass 2", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		resetAllRateLimits();
	});

	describe("bootstrap rate limiting", () => {
		const bootstrapPayload = {
			installation_id: "test-install-1",
			platform: "ios",
			app_version: "1.0.0",
		};

		it("allows normal bootstrap requests", async () => {
			const response = await appFetch("/api/mobile/auth/bootstrap", {
				method: "POST",
				body: bootstrapPayload,
			});
			expect(response.status).toBe(200);
		});

		it("rate limits excessive bootstrap requests from same IP", async () => {
			// Send 10 requests (at the limit)
			for (let i = 0; i < 10; i++) {
				const response = await appFetch("/api/mobile/auth/bootstrap", {
					method: "POST",
					body: {
						installation_id: `install-${i}`,
						platform: "ios",
						app_version: "1.0.0",
					},
				});
				expect(response.status).toBe(200);
			}

			// 11th request should be rate limited
			const response = await appFetch("/api/mobile/auth/bootstrap", {
				method: "POST",
				body: bootstrapPayload,
			});
			const body = await errorJson(response);

			expect(response.status).toBe(429);
			expect(body.error.code).toBe("RATE_LIMITED");
		});
	});
});
