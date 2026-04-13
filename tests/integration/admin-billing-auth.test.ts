import { beforeEach, describe, expect, it } from "vitest";
import { adminHeaders, appFetch, errorJson, successJson } from "../helpers/app";
import { resetTestDatabase } from "../helpers/db";
import { insertBillingProduct } from "../helpers/factories";

describe("admin billing auth integration", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("rejects admin billing requests without admin credentials", async () => {
		const response = await appFetch("/api/admin/billing/products");
		const body = await errorJson(response);

		expect(response.status).toBe(401);
		expect(body.error.code).toBe("UNAUTHORIZED");
	});

	it("rejects admin billing requests with the wrong admin credentials", async () => {
		const response = await appFetch("/api/admin/billing/products", {
			headers: { "X-Admin-Key": "wrong-key" },
		});
		const body = await errorJson(response);

		expect(response.status).toBe(401);
		expect(body.error.code).toBe("UNAUTHORIZED");
	});

	it("allows admin billing requests with the configured admin key", async () => {
		const product = await insertBillingProduct({
			rc_product_id: "com.app.coins_250",
			type: "coin_pack",
			name: "250 Coins",
			coin_amount: 250,
		});

		const response = await appFetch("/api/admin/billing/products", {
			headers: adminHeaders(),
		});
		const body = await successJson<typeof product[]>(response);

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data).toEqual([
			expect.objectContaining({
				id: product.id,
				rc_product_id: "com.app.coins_250",
				type: "coin_pack",
				coin_amount: 250,
			}),
		]);
	});
});
