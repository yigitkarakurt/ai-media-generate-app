import { beforeEach, describe, expect, it } from "vitest";
import { adminHeaders, appFetch, authHeaders, errorJson, successJson } from "../helpers/app";
import { resetTestDatabase } from "../helpers/db";
import { createAuthenticatedUser, insertFilter, insertTag } from "../helpers/factories";

describe("filter catalog integration", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("returns mobile-safe filters with preview, tag, and coin cost", async () => {
		const { token } = await createAuthenticatedUser();
		const tag = await insertTag({ slug: "portrait", name: "Portrait", sort_order: 1 });
		const filter = await insertFilter({
			name: "Cinematic Portrait",
			slug: "cinematic-portrait",
			coin_cost: 8,
			tag_id: tag.id,
			preview_image_url: "https://example.test/portrait-preview.jpg",
			provider_name: "openrouter",
			model_key: "bytedance-seed/seedream-4.5",
			operation_type: "image_to_image",
			prompt_template: "Backend-only prompt",
		});

		const response = await appFetch("/api/mobile/filters", {
			headers: authHeaders(token),
		});
		const body = await successJson<Record<string, unknown>[]>(response);

		expect(response.status).toBe(200);
		expect(body.data).toEqual([
			expect.objectContaining({
				id: filter.id,
				slug: "cinematic-portrait",
				coin_cost: 8,
				preview_image_url: "https://example.test/portrait-preview.jpg",
				is_active: true,
				tag: expect.objectContaining({
					id: tag.id,
					slug: "portrait",
					name: "Portrait",
				}),
			}),
		]);
		expect(body.data[0]).not.toHaveProperty("prompt_template");
		expect(body.data[0]).not.toHaveProperty("provider_name");
		expect(body.data[0]).not.toHaveProperty("model_key");
		expect(body.data[0]).not.toHaveProperty("operation_type");
	});

	it("allows admin tag creation and update", async () => {
		const createResponse = await appFetch("/api/admin/tags", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				slug: "cinematic",
				name: "Cinematic",
				sort_order: 20,
			},
		});
		const created = await successJson<{ id: string; slug: string; is_active: boolean }>(createResponse);

		expect(createResponse.status).toBe(201);
		expect(created.data).toMatchObject({
			slug: "cinematic",
			is_active: true,
		});

		const updateResponse = await appFetch(`/api/admin/tags/${created.data.id}`, {
			method: "PATCH",
			headers: adminHeaders(),
			body: {
				name: "Cinema",
				is_active: false,
			},
		});
		const updated = await successJson<{ name: string; is_active: boolean }>(updateResponse);

		expect(updateResponse.status).toBe(200);
		expect(updated.data).toMatchObject({
			name: "Cinema",
			is_active: false,
		});
	});

	it("allows admin filter create and update with tag_id and coin_cost", async () => {
		const tag = await insertTag({ slug: "product", name: "Product" });

		const createResponse = await appFetch("/api/admin/filters", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				name: "Product Hero",
				slug: "product-hero",
				description: "Clean product image",
				category: "product",
				provider_name: "atlas",
				model_key: "alibaba/wan-2.7/image-edit",
				operation_type: "image_to_image",
				prompt_template: "Make this a premium product photo",
				default_params_json: { size: "1024x1024" },
				input_media_types: "image",
				coin_cost: 10,
				tag_id: tag.id,
				preview_image_url: "https://example.test/product-preview.jpg",
				is_active: true,
			},
		});
		const created = await successJson<{ id: string; coin_cost: number; tag: { id: string } }>(createResponse);

		expect(createResponse.status).toBe(201);
		expect(created.data).toMatchObject({
			coin_cost: 10,
			tag: { id: tag.id },
		});

		const updateResponse = await appFetch(`/api/admin/filters/${created.data.id}`, {
			method: "PATCH",
			headers: adminHeaders(),
			body: {
				coin_cost: 12,
				tag_id: null,
				operation_type: "text_to_image",
			},
		});
		const updated = await successJson<{ coin_cost: number; tag: null; operation_type: string }>(updateResponse);

		expect(updateResponse.status).toBe(200);
		expect(updated.data).toMatchObject({
			coin_cost: 12,
			tag: null,
			operation_type: "text_to_image",
		});
	});

	it("rejects admin filter create with an invalid tag_id", async () => {
		const response = await appFetch("/api/admin/filters", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				name: "Bad Tag Filter",
				slug: "bad-tag-filter",
				category: "test",
				provider_name: "openrouter",
				model_key: "bytedance-seed/seedream-4.5",
				operation_type: "text_to_image",
				prompt_template: "Generate an image",
				input_media_types: "image",
				coin_cost: 5,
				tag_id: "99999999-9999-4999-8999-999999999999",
			},
		});
		const body = await errorJson(response);

		expect(response.status).toBe(400);
		expect(body.error.code).toBe("INVALID_TAG_ID");
	});
});
