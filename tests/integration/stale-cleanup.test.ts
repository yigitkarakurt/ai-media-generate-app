import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { resetTestDatabase } from "../helpers/db";
import { insertUser, insertAsset } from "../helpers/factories";

describe("stale pending asset cleanup", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("deletes pending assets older than threshold", async () => {
		const db = env.DB;
		const user = await insertUser();

		// Create a stale pending asset (2 hours ago)
		const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		await insertAsset(user.id, {
			status: "pending",
			created_at: staleTime,
			updated_at: staleTime,
		});

		// Create a recent pending asset (5 minutes ago)
		const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const recentAsset = await insertAsset(user.id, {
			status: "pending",
			created_at: recentTime,
			updated_at: recentTime,
		});

		// Create an uploaded asset (not pending, should not be touched)
		const uploadedAsset = await insertAsset(user.id, {
			status: "uploaded",
			created_at: staleTime,
			updated_at: staleTime,
		});

		// Run the cleanup query directly (same logic as scheduled handler)
		const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		const staleAssets = await db
			.prepare(
				`SELECT id, storage_key FROM assets
				 WHERE status = 'pending' AND created_at < ?
				 ORDER BY created_at ASC
				 LIMIT 50`,
			)
			.bind(cutoff)
			.all<{ id: string; storage_key: string }>();

		expect(staleAssets.results).toHaveLength(1);

		// Delete the stale assets
		for (const asset of staleAssets.results) {
			await db
				.prepare("DELETE FROM assets WHERE id = ? AND status = 'pending'")
				.bind(asset.id)
				.run();
		}

		// Verify: recent pending asset still exists
		const remaining = await db
			.prepare("SELECT id, status FROM assets WHERE user_id = ?")
			.bind(user.id)
			.all<{ id: string; status: string }>();

		const ids = remaining.results.map((r) => r.id);
		expect(ids).toContain(recentAsset.id);
		expect(ids).toContain(uploadedAsset.id);
		expect(remaining.results).toHaveLength(2);
	});

	it("does not delete uploaded or processing assets regardless of age", async () => {
		const db = env.DB;
		const user = await insertUser();
		const oldTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		// Old uploaded asset
		await insertAsset(user.id, {
			status: "uploaded",
			created_at: oldTime,
			updated_at: oldTime,
		});

		// Old processing asset
		await insertAsset(user.id, {
			status: "processing",
			created_at: oldTime,
			updated_at: oldTime,
		});

		const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		const staleAssets = await db
			.prepare(
				`SELECT id FROM assets
				 WHERE status = 'pending' AND created_at < ?`,
			)
			.bind(cutoff)
			.all<{ id: string }>();

		expect(staleAssets.results).toHaveLength(0);
	});
});
