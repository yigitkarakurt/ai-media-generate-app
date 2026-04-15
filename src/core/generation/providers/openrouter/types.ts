import type { DispatchContext } from "../../types";

/* ──────────────── OpenRouter API types (internal) ──────────────── */

/** Content block: plain text */
export interface OpenRouterTextContent {
	type: "text";
	text: string;
}

/** Content block: image URL (used for image_to_image) */
export interface OpenRouterImageUrlContent {
	type: "image_url";
	image_url: { url: string };
}

export type OpenRouterContentBlock = OpenRouterTextContent | OpenRouterImageUrlContent;

export interface OpenRouterMessage {
	role: "user";
	content: OpenRouterContentBlock[];
}

export interface OpenRouterChatRequest {
	model: string;
	modalities: ["image"];
	messages: [OpenRouterMessage];
}

/* ── Response ── */

export interface OpenRouterImageObject {
	image_url?: {
		url?: string;
	};
}

export interface OpenRouterResponseMessage {
	images?: OpenRouterImageObject[];
}

export interface OpenRouterChoice {
	message?: OpenRouterResponseMessage;
}

export interface OpenRouterChatResponse {
	choices?: OpenRouterChoice[];
}

/* ──────────────── Operation type ──────────────── */

/** Controlled by filter config, never by the client. */
export type OperationType = "text_to_image" | "image_to_image";

/* ──────────────── Model adapter contract ──────────────── */

/**
 * Each OpenRouter model gets its own adapter that owns the request-building
 * and response-parsing logic specific to that model.
 *
 * The OpenRouterProvider handles all shared concerns (auth, HTTP call,
 * data URL extraction, R2 write, D1 insert). The adapter only shapes
 * the request payload.
 */
export interface ModelAdapter {
	/** Human-readable label for logs. */
	readonly modelKey: string;

	/**
	 * Build the OpenRouter chat completions request payload.
	 * Called once per generation.
	 */
	buildRequest(ctx: DispatchContext): OpenRouterChatRequest;
}
