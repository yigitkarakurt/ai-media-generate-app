import type { AppBindings } from "../../../../bindings";
import { AppError } from "../../../../shared/errors";
import { generateStorageKey } from "../../../../shared/media";
import type {
	DispatchContext,
	DispatchResult,
	GenerationProvider,
	ProviderStatusResult,
} from "../../types";
import type { ModelAdapter, OpenRouterChatResponse } from "./types";
import { Seedream45Adapter } from "./adapters/seedream-4-5";

/* ──────────────── Constants ──────────────── */

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

/* ──────────────── Adapter registry ──────────────── */

/**
 * Maps model keys to their concrete adapters.
 * Add a new entry here when adding a new OpenRouter model.
 */
const adapterRegistry = new Map<string, ModelAdapter>([
	["bytedance-seed/seedream-4.5", new Seedream45Adapter()],
]);

function resolveAdapter(filterConfig: Record<string, unknown> | null, filterModelId: string): ModelAdapter {
	// Prefer explicit model_key in filter config; fall back to provider_model_id column
	const modelKey =
		typeof filterConfig?.["model_key"] === "string"
			? (filterConfig["model_key"] as string)
			: filterModelId;

	const adapter = adapterRegistry.get(modelKey);
	if (!adapter) {
		console.error(`[openrouter] No adapter registered for model "${modelKey}"`);
		throw AppError.internal(
			`OpenRouter model "${modelKey}" is not supported by this backend`,
		);
	}
	return adapter;
}

/* ──────────────── Output handling ──────────────── */

interface ParsedDataUrl {
	mimeType: string;
	bytes: Uint8Array;
}

/**
 * Parse a data URL of the form: data:<mimeType>;base64,<payload>
 * Validates structure strictly — any deviation throws an internal error.
 */
function parseDataUrl(dataUrl: string): ParsedDataUrl {
	if (!dataUrl.startsWith("data:")) {
		throw AppError.internal("OpenRouter returned a non-data URL image");
	}

	const commaIdx = dataUrl.indexOf(",");
	if (commaIdx === -1) {
		throw AppError.internal("OpenRouter returned a malformed data URL (no comma separator)");
	}

	const meta = dataUrl.slice(5, commaIdx); // strip "data:"
	const payload = dataUrl.slice(commaIdx + 1);

	const parts = meta.split(";");
	const mimeType = parts[0]?.trim();
	const encoding = parts[1]?.trim();

	if (!mimeType || !mimeType.includes("/")) {
		throw AppError.internal("OpenRouter returned a data URL with an unrecognised mime type");
	}

	if (encoding !== "base64") {
		throw AppError.internal(
			`OpenRouter returned a data URL with unsupported encoding "${encoding}" (expected base64)`,
		);
	}

	let bytes: Uint8Array;
	try {
		const binary = atob(payload);
		bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
	} catch {
		throw AppError.internal("OpenRouter returned a data URL whose base64 payload could not be decoded");
	}

	return { mimeType, bytes };
}

function extensionFromMimeType(mimeType: string): string {
	const map: Record<string, string> = {
		"image/jpeg": "jpg",
		"image/jpg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
		"image/gif": "gif",
	};
	const base = mimeType.split(";")[0].trim().toLowerCase();
	return map[base] ?? "jpg";
}

/* ──────────────── Provider implementation ──────────────── */

/**
 * OpenRouter provider adapter.
 *
 * This provider is synchronous: submit() calls OpenRouter, decodes the
 * data URL response, writes the output to R2, creates the output asset
 * row in D1, and returns initialStatus="completed" with outputAssetId set.
 *
 * No polling (checkStatus) is needed for OpenRouter. The cron sync loop
 * will skip jobs already in a terminal state.
 *
 * Model-specific request building is delegated to per-model adapters
 * registered in adapterRegistry. Adding a new model requires only:
 *   1. A new adapter file in ./adapters/
 *   2. A new entry in adapterRegistry
 */
export const openrouterProvider: GenerationProvider = {
	name: "openrouter",

	async submit(ctx: DispatchContext): Promise<DispatchResult> {
		const { request, env } = ctx;
		const apiKey = env.OPENROUTER_API_KEY;

		if (!apiKey) {
			console.error("[openrouter] OPENROUTER_API_KEY is not configured");
			throw AppError.internal("Generation service is not configured");
		}

		/* ── Resolve model adapter ── */
		const adapter = resolveAdapter(request.filterConfig, request.filterModelId);

		/* ── Build request payload ── */
		const payload = adapter.buildRequest(ctx);

		console.log(
			`[openrouter] Submitting job ${request.jobId} → model "${payload.model}" ` +
			`(operation: ${request.filterConfig?.["operation_type"] ?? "text_to_image"})`,
		);

		/* ── Call OpenRouter API ── */
		let response: Response;
		try {
			response = await fetch(OPENROUTER_API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(payload),
			});
		} catch (err) {
			console.error("[openrouter] Network error:", err);
			throw AppError.internal("Generation service is unreachable");
		}

		if (response.status === 401 || response.status === 403) {
			console.error(`[openrouter] Authentication failed (${response.status})`);
			throw AppError.internal("Generation service authentication failed");
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "unknown");
			console.error(`[openrouter] API error ${response.status}: ${text}`);
			throw AppError.internal("Generation service temporarily unavailable");
		}

		/* ── Parse response ── */
		let body: OpenRouterChatResponse;
		try {
			body = (await response.json()) as OpenRouterChatResponse;
		} catch {
			console.error("[openrouter] Failed to parse response JSON");
			throw AppError.internal("Generation service returned an invalid response");
		}

		const imageUrl = body?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
		if (!imageUrl) {
			console.error(
				"[openrouter] Response missing choices[0].message.images[0].image_url.url:",
				JSON.stringify(body),
			);
			throw AppError.internal("Generation service returned an incomplete response");
		}

		/* ── Parse data URL ── */
		const { mimeType, bytes } = parseDataUrl(imageUrl);

		/* ── Write output to R2 ── */
		const now = new Date().toISOString();
		const outputAssetId = crypto.randomUUID();
		const ext = extensionFromMimeType(mimeType);
		const filename = `output_${request.jobId}.${ext}`;

		// Fetch userId from the job row (needed for the storage key path)
		const jobRow = await env.DB
			.prepare("SELECT user_id FROM generation_jobs WHERE id = ?")
			.bind(request.jobId)
			.first<{ user_id: string }>();

		if (!jobRow) {
			console.error(`[openrouter] Job ${request.jobId} not found when writing output`);
			throw AppError.internal("Generation job record not found during output persistence");
		}

		const storageKey = generateStorageKey("output", jobRow.user_id, outputAssetId, filename);

		await env.MEDIA_BUCKET.put(storageKey, bytes, {
			httpMetadata: { contentType: mimeType },
		});

		/* ── Get actual file size ── */
		const headResult = await env.MEDIA_BUCKET.head(storageKey);
		const fileSize = headResult?.size ?? bytes.byteLength;

		/* ── Create output asset record in D1 ── */
		await env.DB
			.prepare(
				`INSERT INTO assets (
					id, user_id, kind, type, status, storage_key,
					original_filename, mime_type, file_size_bytes,
					created_at, updated_at
				) VALUES (?, ?, 'output', 'image', 'ready', ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				outputAssetId,
				jobRow.user_id,
				storageKey,
				filename,
				mimeType,
				fileSize,
				now,
				now,
			)
			.run();

		console.log(
			`[openrouter] Job ${request.jobId} completed — output asset ${outputAssetId} ` +
			`(${fileSize} bytes, ${mimeType})`,
		);

		return {
			providerName: "openrouter",
			// OpenRouter chat completions has no external job ID; use the local job ID
			providerJobId: request.jobId,
			initialStatus: "completed",
			outputAssetId,
		};
	},

	/**
	 * OpenRouter image generation is synchronous — jobs never enter a polling loop.
	 * If checkStatus is ever called on an openrouter job (e.g. by the scheduled
	 * sync picking up a stuck job), return completed immediately.
	 */
	async checkStatus(_providerJobId: string, _env: AppBindings): Promise<ProviderStatusResult> {
		return {
			status: "completed",
			providerRawStatus: "completed",
		};
	},

	async cancel(_providerJobId: string, _env: AppBindings): Promise<void> {
		throw new Error("openrouter.cancel is not implemented");
	},
};
