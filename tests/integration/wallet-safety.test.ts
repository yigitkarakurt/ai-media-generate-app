import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { appFetch, authHeaders, errorJson, successJson } from "../helpers/app";
import {
	getCoinBalance,
	getCoinLedger,
	getWalletBalance,
	resetTestDatabase,
} from "../helpers/db";
import {
	createAuthenticatedUser,
	insertAsset,
	insertCoinEntry,
	insertFilter,
} from "../helpers/factories";
import { resetAllRateLimits } from "../../src/lib/rate-limit";

describe("wallet concurrency safety", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await resetTestDatabase();
		resetAllRateLimits();
	});

	it("prevents overspend when wallet has exact balance for one generation", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertFilter({ coin_cost: 25, input_media_types: "image" });

		// Give user exactly 25 coins (enough for one generation)
		await insertCoinEntry(user.id, 25, "admin_grant");

		// Mock provider to succeed (Atlas expects { data: { id: "..." } })
		// Use mockImplementation to return a FRESH Response per call (body streams are single-read)
		vi.spyOn(globalThis, "fetch").mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ data: { id: `atlas-job-${crypto.randomUUID()}` } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		// First generation should succeed
		const response1 = await appFetch("/api/mobile/generations", {
			method: "POST",
			headers: authHeaders(token),
			body: {
				filter_id: filter.id,
				input_asset_id: asset.id,
				params: {},
			},
		});
		expect(response1.status).toBe(201);

		// Second generation should fail (insufficient coins)
		const response2 = await appFetch("/api/mobile/generations", {
			method: "POST",
			headers: authHeaders(token),
			body: {
				filter_id: filter.id,
				input_asset_id: asset.id,
				params: {},
			},
		});
		const body2 = await errorJson(response2);
		expect(response2.status).toBe(400);
		expect(body2.error.code).toBe("INSUFFICIENT_COINS");

		// Wallet balance should be 0 (not negative)
		expect(await getWalletBalance(user.id)).toBe(0);

		// Ledger should show grant + debit
		const ledger = await getCoinLedger(user.id);
		expect(ledger.map((e) => [e.amount, e.reason])).toEqual([
			[25, "admin_grant"],
			[-25, "generation_debit"],
		]);
	});

	it("refund on dispatch failure restores wallet balance", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertFilter({ coin_cost: 25, input_media_types: "image" });
		await insertCoinEntry(user.id, 50, "admin_grant");

		// Mock provider to fail
		vi.spyOn(globalThis, "fetch").mockImplementation(() =>
			Promise.resolve(new Response("provider unavailable", { status: 503 })),
		);

		const response = await appFetch("/api/mobile/generations", {
			method: "POST",
			headers: authHeaders(token),
			body: {
				filter_id: filter.id,
				input_asset_id: asset.id,
				params: {},
			},
		});
		expect(response.status).toBe(500);

		// Wallet should be fully restored (50 coins)
		expect(await getWalletBalance(user.id)).toBe(50);

		// Ledger should show grant, debit, refund
		const ledger = await getCoinLedger(user.id);
		expect(ledger.map((e) => [e.amount, e.reason])).toEqual([
			[50, "admin_grant"],
			[-25, "generation_debit"],
			[25, "refund"],
		]);

		// Ledger sum should match wallet
		expect(await getCoinBalance(user.id)).toBe(50);
	});

	it("wallet and ledger stay in sync after multiple operations", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertFilter({ coin_cost: 10, input_media_types: "image" });
		await insertCoinEntry(user.id, 100, "admin_grant");

		// Use mockImplementation to return a FRESH Response per call (body streams are single-read)
		vi.spyOn(globalThis, "fetch").mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ data: { id: `atlas-job-${crypto.randomUUID()}` } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		// Run 3 generations successfully
		for (let i = 0; i < 3; i++) {
			const response = await appFetch("/api/mobile/generations", {
				method: "POST",
				headers: authHeaders(token),
				body: {
					filter_id: filter.id,
					input_asset_id: asset.id,
					params: {},
				},
			});
			expect(response.status).toBe(201);
		}

		// Wallet should be 70 (100 - 3 * 10)
		expect(await getWalletBalance(user.id)).toBe(70);
		// Ledger sum should match
		expect(await getCoinBalance(user.id)).toBe(70);
	});
});
