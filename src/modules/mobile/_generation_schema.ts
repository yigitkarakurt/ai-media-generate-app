import type { FilterRow } from "../../core/db/schema";

/* ──────────────── generation_schema contract ──────────────── */

/**
 * The subset of FilterRow fields needed to build a generation_schema.
 * All 4 mobile catalog endpoints reference this shape.
 */
export interface GenerationSchemaSource {
	operation_type: string;
	output_media_type: string;
	requires_media: number;
	input_media_type: string;
	min_media_count: number;
	max_media_count: number;
	supported_mime_types_json: string | null;
	max_file_size_mb: number | null;
}

export interface GenerationSchema {
	operation_type: string;
	output_media_type: string;
	requires_media: boolean;
	input_media_type: string;
	min_media_count: number;
	max_media_count: number;
	supported_mime_types: string[];
	max_file_size_mb: number;
	/** Always false for filter/effect generation — the prompt is owned by the backend. */
	allows_user_prompt: false;
}

const DEFAULT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DEFAULT_MAX_FILE_SIZE_MB = 15;

/**
 * Build the client-safe generation_schema from a filter row.
 * Exposed on every mobile filter response so the mobile app can draw
 * upload UI, validate counts, and understand output type — all without
 * touching any provider-internal fields.
 */
export function buildGenerationSchema(row: GenerationSchemaSource): GenerationSchema {
	let supportedMimeTypes: string[] = DEFAULT_MIME_TYPES;
	if (row.supported_mime_types_json) {
		try {
			const parsed = JSON.parse(row.supported_mime_types_json) as unknown;
			if (Array.isArray(parsed)) {
				supportedMimeTypes = parsed as string[];
			}
		} catch {
			// fall back to default
		}
	}

	return {
		operation_type: row.operation_type,
		output_media_type: row.output_media_type || "image",
		requires_media: Boolean(row.requires_media),
		input_media_type: row.input_media_type || "image",
		min_media_count: row.min_media_count ?? 1,
		max_media_count: row.max_media_count ?? 1,
		supported_mime_types: supportedMimeTypes,
		max_file_size_mb: row.max_file_size_mb ?? DEFAULT_MAX_FILE_SIZE_MB,
		allows_user_prompt: false,
	};
}

// Convenience re-export so routes can do a single import
export type { FilterRow };
