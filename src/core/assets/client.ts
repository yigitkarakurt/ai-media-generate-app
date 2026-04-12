import type { AssetRow } from "../db/schema";
import type { AppBindings } from "../../bindings";
import { createPresignedReadUrl } from "../../lib/r2";

/** How long signed read URLs are valid (matches r2.ts READ_URL_EXPIRY_SECONDS). */
const READ_URL_EXPIRY_SECONDS = 3600;

/** Asset statuses where the file exists in R2 and can be read. */
const READABLE_STATUSES = new Set(["uploaded", "ready"]);

/* ──────────────── Client-safe asset type ──────────────── */

export interface ClientAsset {
	id: string;
	kind: "input" | "output";
	media_type: "image" | "video";
	status: string;
	original_filename: string;
	mime_type: string;
	size_bytes: number;
	width: number | null;
	height: number | null;
	duration_seconds: number | null;
	created_at: string;
	updated_at: string;
	read_url: string | null;
	read_url_expires_at: string | null;
}

/* ──────────────── Helper ──────────────── */

/**
 * Convert a DB asset row to a client-safe shape.
 *
 * Strips internal fields (storage_key, user_id, metadata) and generates
 * a short-lived signed read URL for assets that exist in R2.
 */
export async function toClientAsset(
	row: AssetRow,
	env: AppBindings,
): Promise<ClientAsset> {
	let readUrl: string | null = null;
	let readUrlExpiresAt: string | null = null;

	if (READABLE_STATUSES.has(row.status) && row.storage_key) {
		readUrl = await createPresignedReadUrl(env, row.storage_key);
		readUrlExpiresAt = new Date(Date.now() + READ_URL_EXPIRY_SECONDS * 1000).toISOString();
	}

	return {
		id: row.id,
		kind: row.kind,
		media_type: row.type,
		status: row.status,
		original_filename: row.original_filename,
		mime_type: row.mime_type,
		size_bytes: row.file_size_bytes,
		width: row.width,
		height: row.height,
		duration_seconds: row.duration_seconds,
		created_at: row.created_at,
		updated_at: row.updated_at,
		read_url: readUrl,
		read_url_expires_at: readUrlExpiresAt,
	};
}
