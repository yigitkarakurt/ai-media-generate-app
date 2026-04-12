/* ──────────────── Media validation constants ──────────────── */

export const ALLOWED_IMAGE_MIME_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/heic",
	"image/heif",
] as const;

export const ALLOWED_VIDEO_MIME_TYPES = [
	"video/mp4",
	"video/quicktime",
	"video/webm",
] as const;

export const ALLOWED_MIME_TYPES = [
	...ALLOWED_IMAGE_MIME_TYPES,
	...ALLOWED_VIDEO_MIME_TYPES,
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** 100 MB — applies to both image and video for now */
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export const ASSET_KINDS = ["input", "output"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const MEDIA_TYPES = ["image", "video"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const ASSET_STATUSES = [
	"pending",
	"uploaded",
	"processing",
	"ready",
	"failed",
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Upload presigned URL validity duration in seconds */
export const UPLOAD_URL_EXPIRY_SECONDS = 600; // 10 minutes

export function mediaTypeFromMime(mimeType: string): MediaType {
	if (ALLOWED_IMAGE_MIME_TYPES.includes(mimeType as any)) return "image";
	if (ALLOWED_VIDEO_MIME_TYPES.includes(mimeType as any)) return "video";
	throw new Error(`Unsupported mime type: ${mimeType}`);
}

export function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
	return ALLOWED_MIME_TYPES.includes(mimeType as any);
}

/**
 * Generate an R2 object key for an asset.
 * Format: {kind}/{userId}/{assetId}/{filename}
 * This structure makes it easy to list/cleanup by user or by kind.
 */
export function generateStorageKey(
	kind: AssetKind,
	userId: string,
	assetId: string,
	filename: string,
): string {
	// Sanitize filename: keep only alphanumeric, dots, hyphens, underscores
	const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
	return `${kind}/${userId}/${assetId}/${safe}`;
}
