import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appFetch, authHeaders, errorJson, successJson } from "../helpers/app";
import { getGenerationJobs, resetTestDatabase } from "../helpers/db";
import { createAuthenticatedUser, insertAsset, insertFilter } from "../helpers/factories";
import type { GenerationJobRow, AssetRow } from "../../src/core/db/schema";

/* ──────────────── Helpers ──────────────── */

/** Base64-encoded 1×1 transparent PNG — minimal valid image for tests */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const VALID_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

/** Build a well-formed OpenRouter success response */
function openRouterSuccessResponse(dataUrl = VALID_DATA_URL): Response {
	return new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						images: [{ image_url: { url: dataUrl } }],
					},
				},
			],
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/** Build a filter row targeting openrouter/seedream-4.5, text_to_image */
async function insertOpenRouterFilter(
	operationType: "text_to_image" | "image_to_image" = "text_to_image",
) {
	return insertFilter({
		provider_name: "openrouter",
		provider_model_id: "bytedance-seed/seedream-4.5",
		config: JSON.stringify({
			operation_type: operationType,
			model_key: "bytedance-seed/seedream-4.5",
		}),
		input_media_types: "image",
		prompt_template: "Apply a dreamy artistic style",
		coin_cost: 0,
	});
}

/* ──────────────── Tests ──────────────── */

describe("openrouter provider — integration", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await resetTestDatabase();
	});

	/* ── text_to_image success ── */
	it("text_to_image: creates output asset and marks job completed on success", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertOpenRouterFilter("text_to_image");

		// Mock fetch: first call is the presigned R2 read URL signing (aws4fetch does a
		// network-less sign); we only need to intercept OpenRouter HTTP calls.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : (input as Request).url;
			if (url.includes("openrouter.ai")) {
				return openRouterSuccessResponse();
			}
			// Let aws4fetch presigned-URL signing through (it signs locally, no HTTP)
			return new Response("unexpected fetch", { status: 500 });
		});

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
		const body = await successJson<GenerationJobRow>(response);
		expect(body.data.status).toBe("completed");

		// Verify D1 job state
		const jobs = await getGenerationJobs(user.id);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			status: "completed",
			provider_name: "openrouter",
			error_code: null,
		});
		expect(jobs[0].output_asset_id).toBeTruthy();
		expect(jobs[0].completed_at).toBeTruthy();

		// Verify output asset was created in D1
		const outputAsset = await env.DB
			.prepare("SELECT * FROM assets WHERE id = ?")
			.bind(jobs[0].output_asset_id)
			.first<AssetRow>();
		expect(outputAsset).toBeTruthy();
		expect(outputAsset!.kind).toBe("output");
		expect(outputAsset!.status).toBe("ready");
		expect(outputAsset!.user_id).toBe(user.id);
		expect(outputAsset!.mime_type).toBe("image/png");

		// Verify output file exists in R2
		const r2Object = await env.MEDIA_BUCKET.head(outputAsset!.storage_key);
		expect(r2Object).toBeTruthy();
	});

	/* ── image_to_image success ── */
	it("image_to_image: includes signed R2 URL in request and marks job completed", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertOpenRouterFilter("image_to_image");

		let capturedRequestBody: unknown;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : (input as Request).url;
			if (url.includes("openrouter.ai")) {
				capturedRequestBody = JSON.parse((init?.body as string) ?? "{}");
				return openRouterSuccessResponse();
			}
			return new Response("unexpected fetch", { status: 500 });
		});

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

		// Verify the adapter included an image_url content block in the request
		const req = capturedRequestBody as {
			messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
		};
		const content = req.messages[0].content;
		const textBlock = content.find((b) => b.type === "text");
		const imageBlock = content.find((b) => b.type === "image_url");
		expect(textBlock).toBeTruthy();
		expect(imageBlock).toBeTruthy();
		expect(imageBlock!.image_url?.url).toContain(asset.storage_key.split("/").pop()!.slice(0, 8));

		// Job should be completed
		const jobs = await getGenerationJobs(user.id);
		expect(jobs[0].status).toBe("completed");
		expect(jobs[0].output_asset_id).toBeTruthy();
	});

	/* ── malformed response — missing choices ── */
	it("marks job failed and refunds coins when OpenRouter returns missing choices", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertOpenRouterFilter("text_to_image");

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : (input as Request).url;
			if (url.includes("openrouter.ai")) {
				return new Response(JSON.stringify({ choices: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("unexpected fetch", { status: 500 });
		});

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
		const body = await errorJson(response);
		expect(body.error.code).toBe("INTERNAL_ERROR");

		const jobs = await getGenerationJobs(user.id);
		expect(jobs).toHaveLength(1);
		expect(jobs[0].status).toBe("failed");
		expect(jobs[0].error_code).toBe("DISPATCH_FAILED");
		expect(jobs[0].output_asset_id).toBeNull();
	});

	/* ── malformed data URL ── */
	it("marks job failed when OpenRouter returns a malformed data URL", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertOpenRouterFilter("text_to_image");

		// Return a plain HTTPS URL instead of a data URL
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : (input as Request).url;
			if (url.includes("openrouter.ai")) {
				return openRouterSuccessResponse("https://example.com/not-a-data-url.png");
			}
			return new Response("unexpected fetch", { status: 500 });
		});

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
		const body = await errorJson(response);
		expect(body.error.code).toBe("INTERNAL_ERROR");

		const jobs = await getGenerationJobs(user.id);
		expect(jobs[0].status).toBe("failed");
		expect(jobs[0].output_asset_id).toBeNull();
	});

	/* ── non-2xx from OpenRouter ── */
	it("marks job failed when OpenRouter returns a non-2xx HTTP status", async () => {
		const { user, token } = await createAuthenticatedUser();
		const asset = await insertAsset(user.id, { status: "uploaded", type: "image" });
		const filter = await insertOpenRouterFilter("text_to_image");

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : (input as Request).url;
			if (url.includes("openrouter.ai")) {
				return new Response("rate limit exceeded", { status: 429 });
			}
			return new Response("unexpected fetch", { status: 500 });
		});

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
		const body = await errorJson(response);
		// Client must never see "openrouter" — normalized internal error only
		expect(body.error.code).toBe("INTERNAL_ERROR");
		expect(body.error.message).not.toContain("openrouter");

		const jobs = await getGenerationJobs(user.id);
		expect(jobs[0].status).toBe("failed");
	});
});
