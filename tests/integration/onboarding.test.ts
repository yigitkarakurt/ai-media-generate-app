import { beforeEach, describe, expect, it } from "vitest";
import { adminHeaders, appFetch, errorJson, successJson } from "../helpers/app";
import { resetTestDatabase } from "../helpers/db";
import { insertOnboardingFlow, insertOnboardingScreen } from "../helpers/factories";

describe("onboarding integration", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	/* ═══════════════ Mobile onboarding endpoint ═══════════════ */

	it("returns active onboarding screens ordered by sort_order", async () => {
		const flow = await insertOnboardingFlow({ key: "default", is_active: 1 });
		const s1 = await insertOnboardingScreen(flow.id, {
			title: "Screen One",
			sort_order: 20,
			media_type: "image",
			media_url: "https://cdn.example.com/one.jpg",
		});
		const s2 = await insertOnboardingScreen(flow.id, {
			title: "Screen Two",
			sort_order: 10,
			media_type: "video",
			media_url: "https://cdn.example.com/two.mp4",
		});

		const response = await appFetch("/api/mobile/onboarding");
		const body = await successJson<{
			flow: { id: string; key: string; name: string };
			screens: { id: string; title: string; sort_order: number }[];
		}>(response);

		expect(response.status).toBe(200);
		expect(body.data.flow).toMatchObject({ id: flow.id, key: "default" });
		expect(body.data.screens).toHaveLength(2);
		// Sort order: s2 (10) before s1 (20)
		expect(body.data.screens[0]).toMatchObject({ id: s2.id, title: "Screen Two", sort_order: 10 });
		expect(body.data.screens[1]).toMatchObject({ id: s1.id, title: "Screen One", sort_order: 20 });
	});

	it("excludes inactive screens from mobile response", async () => {
		const flow = await insertOnboardingFlow({ key: "default", is_active: 1 });
		await insertOnboardingScreen(flow.id, {
			title: "Active",
			sort_order: 10,
			is_active: 1,
		});
		await insertOnboardingScreen(flow.id, {
			title: "Inactive",
			sort_order: 20,
			is_active: 0,
		});

		const response = await appFetch("/api/mobile/onboarding");
		const body = await successJson<{
			flow: { id: string };
			screens: { title: string }[];
		}>(response);

		expect(body.data.screens).toHaveLength(1);
		expect(body.data.screens[0].title).toBe("Active");
	});

	it("returns empty response when no active flow exists", async () => {
		// No flow at all
		const response = await appFetch("/api/mobile/onboarding");
		const body = await successJson<{
			flow: null;
			screens: unknown[];
		}>(response);

		expect(response.status).toBe(200);
		expect(body.data.flow).toBeNull();
		expect(body.data.screens).toEqual([]);
	});

	it("ignores inactive flow", async () => {
		const flow = await insertOnboardingFlow({ key: "old", is_active: 0 });
		await insertOnboardingScreen(flow.id, { title: "Should not appear" });

		const response = await appFetch("/api/mobile/onboarding");
		const body = await successJson<{ flow: null; screens: unknown[] }>(response);

		expect(body.data.flow).toBeNull();
		expect(body.data.screens).toEqual([]);
	});

	it("mobile response does not expose internal fields", async () => {
		const flow = await insertOnboardingFlow({ is_active: 1 });
		await insertOnboardingScreen(flow.id, { title: "Test" });

		const response = await appFetch("/api/mobile/onboarding");
		const body = await successJson<{
			flow: Record<string, unknown>;
			screens: Record<string, unknown>[];
		}>(response);

		// Flow should not expose is_active, created_at, updated_at
		expect(body.data.flow).not.toHaveProperty("is_active");
		expect(body.data.flow).not.toHaveProperty("created_at");
		expect(body.data.flow).not.toHaveProperty("updated_at");

		// Screens should not expose flow_id, is_active, created_at, updated_at
		const screen = body.data.screens[0];
		expect(screen).not.toHaveProperty("flow_id");
		expect(screen).not.toHaveProperty("is_active");
		expect(screen).not.toHaveProperty("created_at");
		expect(screen).not.toHaveProperty("updated_at");
	});

	/* ═══════════════ Admin screen CRUD ═══════════════ */

	it("admin can create an onboarding screen", async () => {
		const flow = await insertOnboardingFlow({ key: "admin-test", is_active: 1 });

		const response = await appFetch("/api/admin/onboarding/screens", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				flow_id: flow.id,
				title: "Welcome",
				subtitle: "Get started",
				description: "This is the first screen",
				media_type: "video",
				media_url: "https://cdn.example.com/welcome.mp4",
				cta_text: "Next",
				sort_order: 10,
			},
		});
		const body = await successJson<{ id: string; title: string; media_type: string; is_active: boolean }>(response);

		expect(response.status).toBe(201);
		expect(body.data).toMatchObject({
			title: "Welcome",
			media_type: "video",
			is_active: true,
		});
	});

	it("admin can update an onboarding screen", async () => {
		const flow = await insertOnboardingFlow({ is_active: 1 });
		const screen = await insertOnboardingScreen(flow.id, {
			title: "Old Title",
			media_type: "image",
			media_url: "https://cdn.example.com/old.jpg",
		});

		const response = await appFetch(`/api/admin/onboarding/screens/${screen.id}`, {
			method: "PATCH",
			headers: adminHeaders(),
			body: {
				title: "New Title",
				is_active: false,
			},
		});
		const body = await successJson<{ title: string; is_active: boolean }>(response);

		expect(response.status).toBe(200);
		expect(body.data).toMatchObject({
			title: "New Title",
			is_active: false,
		});
	});

	it("rejects invalid media_type on screen creation", async () => {
		const flow = await insertOnboardingFlow({ is_active: 1 });

		const response = await appFetch("/api/admin/onboarding/screens", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				flow_id: flow.id,
				title: "Bad Media",
				media_type: "pdf",
				media_url: "https://cdn.example.com/doc.pdf",
				sort_order: 10,
			},
		});

		expect(response.status).toBe(400);
		const body = await errorJson(response);
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects screen creation with non-existent flow_id", async () => {
		const response = await appFetch("/api/admin/onboarding/screens", {
			method: "POST",
			headers: adminHeaders(),
			body: {
				flow_id: "99999999-9999-4999-8999-999999999999",
				title: "Orphan Screen",
				media_type: "image",
				media_url: "https://cdn.example.com/orphan.jpg",
				sort_order: 10,
			},
		});

		expect(response.status).toBe(400);
		const body = await errorJson(response);
		expect(body.error.code).toBe("INVALID_FLOW_ID");
	});

	it("admin can delete an onboarding screen", async () => {
		const flow = await insertOnboardingFlow({ is_active: 1 });
		const screen = await insertOnboardingScreen(flow.id, { title: "To Delete" });

		const response = await appFetch(`/api/admin/onboarding/screens/${screen.id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});

		expect(response.status).toBe(200);

		// Verify it's gone from mobile response
		const mobileResponse = await appFetch("/api/mobile/onboarding");
		const mobileBody = await successJson<{ screens: unknown[] }>(mobileResponse);
		expect(mobileBody.data.screens).toHaveLength(0);
	});

	/* ═══════════════ Admin flow management ═══════════════ */

	it("activating a flow deactivates others", async () => {
		const flow1 = await insertOnboardingFlow({ key: "first", is_active: 1 });
		await insertOnboardingScreen(flow1.id, { title: "Flow 1 Screen" });

		// Create second flow via API and activate it
		const createRes = await appFetch("/api/admin/onboarding/flows", {
			method: "POST",
			headers: adminHeaders(),
			body: { key: "second", name: "Second Flow", is_active: true },
		});
		const created = await successJson<{ id: string; is_active: boolean }>(createRes);
		expect(created.data.is_active).toBe(true);

		// Mobile endpoint should now return second flow (no screens)
		const mobileRes = await appFetch("/api/mobile/onboarding");
		const mobile = await successJson<{ flow: { key: string }; screens: unknown[] }>(mobileRes);
		expect(mobile.data.flow.key).toBe("second");
		expect(mobile.data.screens).toHaveLength(0);
	});
});
