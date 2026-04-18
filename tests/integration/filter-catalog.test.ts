import { beforeEach, describe, expect, it } from "vitest";
import { adminHeaders, appFetch, authHeaders, errorJson, successJson } from "../helpers/app";
import { resetTestDatabase } from "../helpers/db";
import {
	createAuthenticatedUser,
	insertCategory,
	insertFilter,
	insertFilterCategory,
	insertFilterPreview,
	insertTag,
} from "../helpers/factories";

describe("filter catalog integration", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	/* ═══════════════ Mobile filter list ═══════════════ */

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

	it("returns the full previews array ordered by sort_order", async () => {
		const { token } = await createAuthenticatedUser();
		const filter = await insertFilter({
			slug: "preview-test",
			preview_image_url: "https://example.test/legacy.jpg",
		});
		await insertFilterPreview(filter.id, {
			preview_url: "https://example.test/secondary.jpg",
			is_primary: 0,
			sort_order: 1,
		});
		await insertFilterPreview(filter.id, {
			preview_url: "https://example.test/primary.jpg",
			is_primary: 1,
			sort_order: 0,
		});

		const response = await appFetch("/api/mobile/filters", {
			headers: authHeaders(token),
		});
		const body = await successJson<Record<string, unknown>[]>(response);

		const item = body.data[0] as { previews: { preview_url: string; sort_order: number; media_type: string }[] };
		expect(item).not.toHaveProperty("primary_preview");
		expect(item.previews).toHaveLength(2);
		expect(item.previews[0]).toMatchObject({
			preview_url: "https://example.test/primary.jpg",
			sort_order: 0,
			media_type: "image",
		});
		expect(item.previews[1]).toMatchObject({
			preview_url: "https://example.test/secondary.jpg",
			sort_order: 1,
		});
		expect(item.previews[0]).not.toHaveProperty("is_primary");
	});

	it("returns an empty previews array when no filter_previews exist", async () => {
		const { token } = await createAuthenticatedUser();
		await insertFilter({
			slug: "fallback-test",
			preview_image_url: "https://example.test/legacy.jpg",
		});

		const response = await appFetch("/api/mobile/filters", {
			headers: authHeaders(token),
		});
		const body = await successJson<Record<string, unknown>[]>(response);

		const item = body.data[0] as { previews: unknown[]; preview_image_url: string };
		expect(item).not.toHaveProperty("primary_preview");
		expect(item.previews).toEqual([]);
		expect(item.preview_image_url).toBe("https://example.test/legacy.jpg");
	});

	/* ═══════════════ Mobile filter detail ═══════════════ */

	it("filter detail returns full preview gallery and categories", async () => {
		const { token } = await createAuthenticatedUser();
		const category = await insertCategory({ slug: "portraits", name: "Portraits" });
		const filter = await insertFilter({ slug: "detail-test" });
		await insertFilterPreview(filter.id, { preview_url: "https://example.test/a.jpg", is_primary: 1, sort_order: 0 });
		await insertFilterPreview(filter.id, { preview_url: "https://example.test/b.jpg", is_primary: 0, sort_order: 1 });
		await insertFilterCategory(filter.id, category.id, 10);

		const response = await appFetch("/api/mobile/filters/detail-test", {
			headers: authHeaders(token),
		});
		const body = await successJson<Record<string, unknown>>(response);

		expect(response.status).toBe(200);
		expect(body.data).toMatchObject({
			id: filter.id,
			slug: "detail-test",
		});

		const data = body.data as { previews: unknown[]; categories: unknown[] };
		expect(data.previews).toHaveLength(2);
		expect(data.categories).toHaveLength(1);
		expect(data.categories[0]).toMatchObject({ slug: "portraits", name: "Portraits" });
	});

	/* ═══════════════ Mobile home ═══════════════ */

	it("home returns featured filters and home categories", async () => {
		const { token } = await createAuthenticatedUser();
		const tag = await insertTag({ slug: "popular", name: "Popular" });
		const category = await insertCategory({
			slug: "trending",
			name: "Trending",
			show_on_home: 1,
			home_sort_order: 10,
		});

		const featured = await insertFilter({
			slug: "feat-filter",
			name: "Featured Filter",
			is_featured: 1,
			featured_sort_order: 10,
			tag_id: tag.id,
			coin_cost: 5,
		});
		const regular = await insertFilter({
			slug: "regular-filter",
			name: "Regular Filter",
			is_featured: 0,
		});

		await insertFilterCategory(featured.id, category.id, 10);
		await insertFilterCategory(regular.id, category.id, 20);

		const response = await appFetch("/api/mobile/home", {
			headers: authHeaders(token),
		});
		const body = await successJson<{
			featured: { slug: string }[];
			categories: { slug: string; filters: { slug: string }[] }[];
		}>(response);

		expect(response.status).toBe(200);

		// Featured section
		expect(body.data.featured).toHaveLength(1);
		expect(body.data.featured[0]).toMatchObject({
			slug: "feat-filter",
			coin_cost: 5,
			tag: expect.objectContaining({ slug: "popular" }),
		});

		// Categories section
		expect(body.data.categories).toHaveLength(1);
		expect(body.data.categories[0]).toMatchObject({ slug: "trending" });
		expect(body.data.categories[0].filters).toHaveLength(2);
	});

	it("home responses are client-safe", async () => {
		const { token } = await createAuthenticatedUser();
		await insertFilter({
			slug: "safe-check",
			is_featured: 1,
			prompt_template: "SECRET prompt",
			provider_name: "openrouter",
			model_key: "secret-model",
		});

		const response = await appFetch("/api/mobile/home", {
			headers: authHeaders(token),
		});
		const body = await successJson<{ featured: Record<string, unknown>[] }>(response);

		const item = body.data.featured[0];
		expect(item).not.toHaveProperty("prompt_template");
		expect(item).not.toHaveProperty("provider_name");
		expect(item).not.toHaveProperty("model_key");
		expect(item).not.toHaveProperty("config");
		expect(item).not.toHaveProperty("default_params_json");
	});

	/* ═══════════════ Mobile categories ═══════════════ */

	it("lists active categories", async () => {
		const { token } = await createAuthenticatedUser();
		await insertCategory({ slug: "active-cat", name: "Active", is_active: 1, sort_order: 10 });
		await insertCategory({ slug: "inactive-cat", name: "Inactive", is_active: 0, sort_order: 20 });

		const response = await appFetch("/api/mobile/categories", {
			headers: authHeaders(token),
		});
		const body = await successJson<{ slug: string }[]>(response);

		expect(response.status).toBe(200);
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({ slug: "active-cat" });
	});

	it("lists filters in a category by slug (paginated)", async () => {
		const { token } = await createAuthenticatedUser();
		const category = await insertCategory({ slug: "test-cat", name: "Test" });
		const f1 = await insertFilter({ slug: "cat-f1", name: "Filter 1" });
		const f2 = await insertFilter({ slug: "cat-f2", name: "Filter 2" });
		await insertFilterCategory(f1.id, category.id, 10);
		await insertFilterCategory(f2.id, category.id, 20);

		const response = await appFetch("/api/mobile/categories/test-cat/filters", {
			headers: authHeaders(token),
		});
		const body = await successJson<{ slug: string }[]>(response);

		expect(response.status).toBe(200);
		expect(body.data).toHaveLength(2);
		expect(body.data[0]).toMatchObject({ slug: "cat-f1" });
		expect(body.data[1]).toMatchObject({ slug: "cat-f2" });
	});

	/* ═══════════════ Admin tag CRUD ═══════════════ */

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

	/* ═══════════════ Admin filter CRUD ═══════════════ */

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

	it("supports featured_sort_order on admin filter create/update", async () => {
		const createResponse = await appFetch("/api/admin/filters", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				name: "Featured Filter",
				slug: "featured-filter",
				category: "test",
				provider_name: "atlas",
				model_key: "test-model",
				operation_type: "image_to_image",
				input_media_types: "image",
				coin_cost: 5,
				is_featured: true,
				featured_sort_order: 10,
			},
		});
		const created = await successJson<{ id: string; is_featured: boolean; featured_sort_order: number }>(createResponse);

		expect(created.data).toMatchObject({
			is_featured: true,
			featured_sort_order: 10,
		});

		const updateResponse = await appFetch(`/api/admin/filters/${created.data.id}`, {
			method: "PATCH",
			headers: adminHeaders(),
			body: { featured_sort_order: 20 },
		});
		const updated = await successJson<{ featured_sort_order: number }>(updateResponse);

		expect(updated.data.featured_sort_order).toBe(20);
	});

	/* ═══════════════ Admin category CRUD ═══════════════ */

	it("allows admin category creation and update", async () => {
		const createResponse = await appFetch("/api/admin/categories", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				slug: "portraits",
				name: "Portraits",
				description: "Portrait filters",
				show_on_home: true,
				home_sort_order: 10,
			},
		});
		const created = await successJson<{ id: string; slug: string; show_on_home: boolean }>(createResponse);

		expect(createResponse.status).toBe(201);
		expect(created.data).toMatchObject({
			slug: "portraits",
			show_on_home: true,
		});

		const updateResponse = await appFetch(`/api/admin/categories/${created.data.id}`, {
			method: "PATCH",
			headers: adminHeaders(),
			body: { name: "Portrait Styles", show_on_home: false },
		});
		const updated = await successJson<{ name: string; show_on_home: boolean }>(updateResponse);

		expect(updated.data).toMatchObject({
			name: "Portrait Styles",
			show_on_home: false,
		});
	});

	it("allows admin category deletion", async () => {
		const category = await insertCategory({ slug: "to-delete" });
		const filter = await insertFilter({ slug: "in-cat" });
		await insertFilterCategory(filter.id, category.id, 10);

		const response = await appFetch(`/api/admin/categories/${category.id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});

		expect(response.status).toBe(200);
	});

	/* ═══════════════ Admin category ↔ filter assignments ═══════════════ */

	it("allows admin to assign filters to a category via PUT", async () => {
		const category = await insertCategory({ slug: "assign-test" });
		const f1 = await insertFilter({ slug: "a-f1" });
		const f2 = await insertFilter({ slug: "a-f2" });

		const putResponse = await appFetch(`/api/admin/categories/${category.id}/filters`, {
			method: "PUT",
			headers: adminHeaders(),
			body: {
				filters: [
					{ filter_id: f1.id, sort_order: 10 },
					{ filter_id: f2.id, sort_order: 20 },
				],
			},
		});
		const body = await successJson<{ id: string; slug: string }[]>(putResponse);

		expect(putResponse.status).toBe(200);
		expect(body.data).toHaveLength(2);
	});

	it("rejects assignment with invalid filter_id", async () => {
		const category = await insertCategory({ slug: "bad-assign" });

		const response = await appFetch(`/api/admin/categories/${category.id}/filters`, {
			method: "PUT",
			headers: adminHeaders(),
			body: {
				filters: [
					{ filter_id: "99999999-9999-4999-8999-999999999999", sort_order: 0 },
				],
			},
		});
		const body = await errorJson(response);

		expect(response.status).toBe(400);
		expect(body.error.code).toBe("INVALID_FILTER_ID");
	});

	it("allows admin to add/remove filter categories via filter sub-routes", async () => {
		const category = await insertCategory({ slug: "sub-cat" });
		const filter = await insertFilter({ slug: "sub-filter" });

		// Add
		const addResponse = await appFetch(`/api/admin/filters/${filter.id}/categories`, {
			method: "POST",
			headers: adminHeaders(),
			body: { category_id: category.id, sort_order: 5 },
		});
		expect(addResponse.status).toBe(201);

		// List
		const listResponse = await appFetch(`/api/admin/filters/${filter.id}/categories`, {
			headers: adminHeaders(),
		});
		const listBody = await successJson<{ id: string }[]>(listResponse);
		expect(listBody.data).toHaveLength(1);

		// Remove
		const delResponse = await appFetch(`/api/admin/filters/${filter.id}/categories/${category.id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});
		expect(delResponse.status).toBe(200);
	});

	/* ═══════════════ Admin filter previews ═══════════════ */

	it("allows admin to manage filter previews", async () => {
		const filter = await insertFilter({ slug: "preview-mgmt" });

		// Create previews
		const createRes1 = await appFetch(`/api/admin/filters/${filter.id}/previews`, {
			method: "POST",
			headers: adminHeaders(),
			body: {
				preview_url: "https://example.test/preview1.jpg",
				is_primary: true,
				sort_order: 0,
			},
		});
		expect(createRes1.status).toBe(201);
		const preview1 = await successJson<{ id: string; is_primary: boolean }>(createRes1);
		expect(preview1.data.is_primary).toBe(true);

		const createRes2 = await appFetch(`/api/admin/filters/${filter.id}/previews`, {
			method: "POST",
			headers: adminHeaders(),
			body: {
				preview_url: "https://example.test/preview2.jpg",
				sort_order: 1,
			},
		});
		expect(createRes2.status).toBe(201);

		// List
		const listRes = await appFetch(`/api/admin/filters/${filter.id}/previews`, {
			headers: adminHeaders(),
		});
		const listBody = await successJson<{ id: string }[]>(listRes);
		expect(listBody.data).toHaveLength(2);

		// Update
		const preview2 = await successJson<{ id: string }>(createRes2);
		const updateRes = await appFetch(`/api/admin/filters/${filter.id}/previews/${preview2.data.id}`, {
			method: "PATCH",
			headers: adminHeaders(),
			body: { is_primary: true },
		});
		const updated = await successJson<{ is_primary: boolean }>(updateRes);
		expect(updated.data.is_primary).toBe(true);

		// Delete
		const delRes = await appFetch(`/api/admin/filters/${filter.id}/previews/${preview1.data.id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);

		// Verify only one preview remains
		const finalListRes = await appFetch(`/api/admin/filters/${filter.id}/previews`, {
			headers: adminHeaders(),
		});
		const finalList = await successJson<{ id: string }[]>(finalListRes);
		expect(finalList.data).toHaveLength(1);
	});

	it("enforces one primary preview per filter", async () => {
		const filter = await insertFilter({ slug: "primary-enforce" });

		// Create first as primary
		const res1 = await appFetch(`/api/admin/filters/${filter.id}/previews`, {
			method: "POST",
			headers: adminHeaders(),
			body: { preview_url: "https://example.test/a.jpg", is_primary: true },
		});
		const p1 = await successJson<{ id: string; is_primary: boolean }>(res1);
		expect(p1.data.is_primary).toBe(true);

		// Create second as primary — should clear first
		await appFetch(`/api/admin/filters/${filter.id}/previews`, {
			method: "POST",
			headers: adminHeaders(),
			body: { preview_url: "https://example.test/b.jpg", is_primary: true },
		});

		// List and verify only one primary
		const listRes = await appFetch(`/api/admin/filters/${filter.id}/previews`, {
			headers: adminHeaders(),
		});
		const list = await successJson<{ id: string; is_primary: boolean }[]>(listRes);

		const primaries = list.data.filter((p) => p.is_primary);
		expect(primaries).toHaveLength(1);
		expect(primaries[0]).toMatchObject({ is_primary: true });
	});

	/* ═══════════════ Client safety checks ═══════════════ */

	it("mobile category filter responses are client-safe", async () => {
		const { token } = await createAuthenticatedUser();
		const category = await insertCategory({ slug: "safe-cat" });
		const filter = await insertFilter({
			slug: "safe-filter",
			prompt_template: "SECRET",
			provider_name: "openrouter",
			model_key: "secret/model",
		});
		await insertFilterCategory(filter.id, category.id);

		const response = await appFetch("/api/mobile/categories/safe-cat/filters", {
			headers: authHeaders(token),
		});
		const body = await successJson<Record<string, unknown>[]>(response);

		expect(response.status).toBe(200);
		expect(body.data[0]).not.toHaveProperty("prompt_template");
		expect(body.data[0]).not.toHaveProperty("provider_name");
		expect(body.data[0]).not.toHaveProperty("model_key");
		expect(body.data[0]).not.toHaveProperty("config");
	});
});
