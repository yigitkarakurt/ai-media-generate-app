import type { AppBindings } from "../../../bindings";
import { AppError } from "../../../shared/errors";
import type {
	DispatchContext,
	DispatchResult,
	GenerationProvider,
	ProviderStatusResult,
} from "../types";

/* ──────────────── Atlas API types (internal) ──────────────── */

interface AtlasGeneratePayload {
	model: string;
	prompt: string;
	images: string[];
	size?: string;
	n: number;
	thinking_mode?: boolean;
	seed?: number;
	enable_sync_mode: false;
	enable_base64_output: false;
}

interface AtlasGenerateResponse {
	data?: {
		id?: string;
		[key: string]: unknown;
	};
}

interface AtlasPredictionResponse {
	data?: {
		status?: string;
		outputs?: string[];
		error?: string;
		progress?: number;
	};
}

/* ──────────────── Constants ──────────────── */

const ATLAS_API_BASE = "https://api.atlascloud.ai/api/v1";

/* ──────────────── Helpers ──────────────── */

function mapAtlasStatus(raw: string | undefined): import("../types").GenerationStatus {
	switch (raw) {
		case "completed":
		case "succeeded":
			return "completed";
		case "failed":
			return "failed";
		case "processing":
			return "processing";
		default:
			// Unknown intermediate state — treat as still processing
			return "processing";
	}
}

/* ──────────────── Provider implementation ──────────────── */

export const atlasProvider: GenerationProvider = {
	name: "atlas",

	async submit(ctx: DispatchContext): Promise<DispatchResult> {
		const { request, env } = ctx;
		const apiKey = env.ATLASCLOUD_API_KEY;

		if (!apiKey) {
			console.error("[atlas] ATLASCLOUD_API_KEY is not configured");
			throw AppError.internal("Generation service is not configured");
		}

		// Build Atlas payload
		const payload: AtlasGeneratePayload = {
			model: request.filterModelId,
			prompt: request.prompt,
			images: request.inputImageUrls,
			n: 1,
			enable_sync_mode: false,
			enable_base64_output: false,
		};

		// Merge optional default params from filter configuration
		if (request.defaultParams) {
			const dp = request.defaultParams;
			if (typeof dp.size === "string") payload.size = dp.size;
			if (typeof dp.n === "number") payload.n = dp.n;
			if (typeof dp.thinking_mode === "boolean") payload.thinking_mode = dp.thinking_mode;
			if (typeof dp.seed === "number") payload.seed = dp.seed;
		}

		// Call Atlas API
		let response: Response;
		try {
			response = await fetch(`${ATLAS_API_BASE}/model/generateImage`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(payload),
			});
		} catch (err) {
			console.error("[atlas] Network error:", err);
			throw AppError.internal("Generation service is unreachable");
		}

		// Handle auth errors
		if (response.status === 401 || response.status === 403) {
			console.error(`[atlas] Authentication failed (${response.status})`);
			throw AppError.internal("Generation service authentication failed");
		}

		// Handle other non-2xx
		if (!response.ok) {
			const text = await response.text().catch(() => "unknown");
			console.error(`[atlas] API error ${response.status}: ${text}`);
			throw AppError.internal("Generation service temporarily unavailable");
		}

		// Parse response
		let body: AtlasGenerateResponse;
		try {
			body = (await response.json()) as AtlasGenerateResponse;
		} catch {
			console.error("[atlas] Failed to parse response JSON");
			throw AppError.internal("Generation service returned an invalid response");
		}

		const providerJobId = body?.data?.id;
		if (!providerJobId) {
			console.error("[atlas] Response missing data.id:", JSON.stringify(body));
			throw AppError.internal("Generation service returned an incomplete response");
		}

		return {
			providerName: "atlas",
			providerJobId: String(providerJobId),
			initialStatus: "processing",
		};
	},

	async checkStatus(providerJobId: string, env: AppBindings): Promise<ProviderStatusResult> {
		const apiKey = env.ATLASCLOUD_API_KEY;
		if (!apiKey) {
			console.error("[atlas] ATLASCLOUD_API_KEY is not configured");
			throw AppError.internal("Generation service is not configured");
		}

		let response: Response;
		try {
			response = await fetch(`${ATLAS_API_BASE}/model/prediction/${providerJobId}`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			});
		} catch (err) {
			console.error("[atlas] Network error polling prediction:", err);
			throw AppError.internal("Generation service is unreachable");
		}

		if (response.status === 401 || response.status === 403) {
			console.error(`[atlas] Authentication failed polling prediction (${response.status})`);
			throw AppError.internal("Generation service authentication failed");
		}

		if (response.status === 404) {
			console.error(`[atlas] Prediction ${providerJobId} not found`);
			return {
				status: "failed",
				providerRawStatus: "not_found",
				errorMessage: "Provider job not found",
			};
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "unknown");
			console.error(`[atlas] Prediction poll error ${response.status}: ${text}`);
			throw AppError.internal("Generation service temporarily unavailable");
		}

		let body: AtlasPredictionResponse;
		try {
			body = (await response.json()) as AtlasPredictionResponse;
		} catch {
			console.error("[atlas] Failed to parse prediction response JSON");
			throw AppError.internal("Generation service returned an invalid response");
		}

		const rawStatus = body?.data?.status ?? "unknown";
		const status = mapAtlasStatus(rawStatus);

		return {
			status,
			providerRawStatus: rawStatus,
			resultUrl: status === "completed" ? body?.data?.outputs?.[0] : undefined,
			errorMessage: status === "failed" ? (body?.data?.error ?? "Generation failed at provider") : undefined,
			progress: body?.data?.progress,
		};
	},

	async cancel(_providerJobId: string, _env: AppBindings): Promise<void> {
		throw new Error("atlas.cancel is not implemented yet");
	},
};
