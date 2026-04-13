import { beforeEach, describe, expect, it, vi } from "vitest";
import { appFetch, authHeaders, errorJson } from "../helpers/app";
import {
	getCoinBalance,
	getCoinLedger,
	getGenerationJobs,
	resetTestDatabase,
} from "../helpers/db";
import {
	createAuthenticatedUser,
	insertAsset,
	insertCoinEntry,
	insertFilter,
} from "../helpers/factories";

describe("mobile generation billing integration", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await resetTestDatabase();
	});

	it("rejects paid generation when coin balance is too low", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertFilter({ coin_cost: 25, input_media_types: "image" });
		const dispatchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Provider dispatch should not run"),
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
		const body = await errorJson(response);

		expect(response.status).toBe(400);
		expect(body.error.code).toBe("INSUFFICIENT_COINS");
		expect(body.error.message).toContain("costs 25 coins");
		expect(dispatchSpy).not.toHaveBeenCalled();
		expect(await getCoinLedger(user.id)).toEqual([]);
		expect(await getGenerationJobs(user.id)).toEqual([]);
	});

	it("refunds the generation debit when provider dispatch fails", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertFilter({ coin_cost: 25, input_media_types: "image" });
		await insertCoinEntry(user.id, 50, "admin_grant");

		const dispatchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("provider unavailable", { status: 503 }),
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
		const body = await errorJson(response);

		expect(response.status).toBe(500);
		expect(body.error.code).toBe("INTERNAL_ERROR");
		expect(dispatchSpy).toHaveBeenCalledOnce();

		const ledger = await getCoinLedger(user.id);
		expect(ledger.map((entry) => [entry.amount, entry.reason])).toEqual([
			[50, "admin_grant"],
			[-25, "generation_debit"],
			[25, "refund"],
		]);
		expect(await getCoinBalance(user.id)).toBe(50);

		const jobs = await getGenerationJobs(user.id);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			status: "failed",
			error_code: "DISPATCH_FAILED",
			provider_job_id: null,
			provider_status: null,
		});
	});
});
