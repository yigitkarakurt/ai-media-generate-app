import type { AppBindings } from "../../bindings";

/* ──────────────── Provider-Agnostic Generation Domain ──────────────── */

/**
 * Normalized generation job statuses.
 * The client only ever sees these values — never raw provider statuses.
 *
 * Lifecycle:  queued → processing → completed
 *                                 → failed
 */
export const GENERATION_STATUSES = ["queued", "processing", "completed", "failed"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export function isValidGenerationStatus(s: string): s is GenerationStatus {
	return (GENERATION_STATUSES as readonly string[]).includes(s);
}

/* ──────────────── Provider dispatch types ──────────────── */

/** Input to the provider dispatch layer — everything needed to kick off a generation. */
export interface DispatchRequest {
	jobId: string;
	filterModelId: string;
	filterConfig: Record<string, unknown> | null;
	inputStorageKey: string;
	inputMediaType: "image" | "video";
	params: Record<string, unknown>;
	/** Which provider adapter to route to (from filter.provider_name). */
	providerName: string;
	/** Backend-managed prompt text (from filter.prompt_template). */
	prompt: string;
	/** Signed R2 read URLs for input images. Array for future multi-image support. */
	inputImageUrls: string[];
	/** Provider-specific default parameters (from filter.default_params_json). */
	defaultParams: Record<string, unknown> | null;
}

/** Bundles everything a provider adapter needs to submit a job. */
export interface DispatchContext {
	request: DispatchRequest;
	env: AppBindings;
}

/** Result returned by the provider dispatch layer. */
export interface DispatchResult {
	providerName: string;
	providerJobId: string;
	/** The status the provider reports immediately after submission. */
	initialStatus: GenerationStatus;
}

/**
 * Abstraction over any AI generation provider (fal.ai, Atlas, Replicate, etc.).
 * Implement this interface per provider. The rest of the system never
 * touches provider SDKs directly.
 */
export interface GenerationProvider {
	readonly name: string;

	submit(ctx: DispatchContext): Promise<DispatchResult>;
	checkStatus(providerJobId: string, env: AppBindings): Promise<ProviderStatusResult>;
	cancel(providerJobId: string, env: AppBindings): Promise<void>;
}

/** Returned by a provider when polling job status. */
export interface ProviderStatusResult {
	status: GenerationStatus;
	providerRawStatus: string;
	resultUrl?: string;
	errorMessage?: string;
	progress?: number; // 0–100
}
