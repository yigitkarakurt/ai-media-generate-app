import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../../middleware/auth";
import { requireAuth } from "../../middleware/auth";
import { success } from "../../shared/api-response";
import { AppError } from "../../shared/errors";
import {
	isAllowedMimeType,
	mediaTypeFromMime,
	generateStorageKey,
	MAX_FILE_SIZE_BYTES,
} from "../../shared/media";
import { createPresignedUploadUrl } from "../../lib/r2";
import type { AssetRow } from "../../core/db/schema";
import { toClientAsset } from "../../core/assets/client";
import { checkRateLimit } from "../../lib/rate-limit";

/* ──────────────── Validation schemas ──────────────── */

const uploadRequestSchema = z.object({
	filename: z.string().min(1).max(255),
	mimeType: z.string().min(1),
	fileSizeBytes: z.number().int().positive(),
});

const uploadConfirmSchema = z.object({
	assetId: z.string().uuid(),
	fileSizeBytes: z.number().int().positive().optional(),
	mimeType: z.string().optional(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
	durationSeconds: z.number().positive().optional(),
});

/* ──────────────── Router ──────────────── */

const uploads = new Hono<AuthedEnv>();

// All upload routes require authentication
uploads.use("/*", requireAuth);

/**
 * POST /api/mobile/uploads/request
 *
 * Client sends filename + mimeType + fileSizeBytes.
 * Backend creates a pending asset record and returns a presigned R2 PUT URL.
 * Client then uploads the file directly to R2 using that URL.
 */
uploads.post("/request", async (c) => {
	const userId = c.get("userId");
	const db = c.env.DB;

	// Rate limit: 20 upload requests per user per 60 seconds
	const rl = checkRateLimit("upload-request", userId, { maxRequests: 20, windowSeconds: 60 });
	if (!rl.allowed) {
		console.warn(`[security:rate-limit] Upload request rate limited: user=${userId}`);
		throw AppError.tooManyRequests("Too many upload requests. Please try again later.");
	}

	const body = await c.req.json();
	const data = uploadRequestSchema.parse(body);

	// Validate mime type
	if (!isAllowedMimeType(data.mimeType)) {
		throw AppError.badRequest(
			"INVALID_MIME_TYPE",
			`Mime type '${data.mimeType}' is not allowed`,
		);
	}

	// Validate file size
	if (data.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
		throw AppError.badRequest(
			"FILE_TOO_LARGE",
			`File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
		);
	}

	const assetId = crypto.randomUUID();
	const mediaType = mediaTypeFromMime(data.mimeType);
	const storageKey = generateStorageKey("input", userId, assetId, data.filename);
	const now = new Date().toISOString();

	// Cap pending assets per user to prevent unbounded growth
	const pendingCount = await db
		.prepare("SELECT COUNT(*) as count FROM assets WHERE user_id = ? AND status = 'pending'")
		.bind(userId)
		.first<{ count: number }>();
	if ((pendingCount?.count ?? 0) >= 10) {
		console.warn(`[security:abuse] Pending asset cap reached: user=${userId}, count=${pendingCount?.count}`);
		throw AppError.badRequest(
			"TOO_MANY_PENDING_UPLOADS",
			"You have too many pending uploads. Please complete or wait for existing uploads to expire.",
		);
	}

	// Create pending asset record
	await db
		.prepare(
			`INSERT INTO assets (id, user_id, kind, type, status, storage_key, original_filename, mime_type, file_size_bytes, created_at, updated_at)
			 VALUES (?, ?, 'input', ?, 'pending', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			assetId,
			userId,
			mediaType,
			storageKey,
			data.filename,
			data.mimeType,
			data.fileSizeBytes,
			now,
			now,
		)
		.run();

	// Generate presigned upload URL
	const { uploadUrl, expiresInSeconds } = await createPresignedUploadUrl(
		c.env,
		storageKey,
	);

	return success(c, {
		assetId,
		uploadUrl,
		storageKey,
		expiresInSeconds,
	}, 201);
});

/**
 * POST /api/mobile/uploads/confirm
 *
 * After the client uploads to R2, it calls this to mark the asset as uploaded.
 * Backend verifies the object exists in R2, updates metadata, and transitions status.
 */
uploads.post("/confirm", async (c) => {
	const body = await c.req.json();
	const data = uploadConfirmSchema.parse(body);
	const userId = c.get("userId");
	const db = c.env.DB;
	const bucket = c.env.MEDIA_BUCKET;

	// Fetch the asset
	const asset = await db
		.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?")
		.bind(data.assetId, userId)
		.first<AssetRow>();

	if (!asset) {
		throw AppError.notFound("Asset");
	}

	// Only pending assets can be confirmed
	if (asset.status !== "pending") {
		throw AppError.badRequest(
			"INVALID_STATE_TRANSITION",
			`Cannot confirm asset in '${asset.status}' status. Only 'pending' assets can be confirmed.`,
		);
	}

	// Verify object exists in R2
	const r2Head = await bucket.head(asset.storage_key);
	if (!r2Head) {
		throw AppError.badRequest(
			"UPLOAD_NOT_FOUND",
			"File not found in storage. Please upload the file first.",
		);
	}

	const now = new Date().toISOString();
	const finalSize = data.fileSizeBytes ?? r2Head.size ?? asset.file_size_bytes;
	const finalMime = data.mimeType ?? r2Head.httpMetadata?.contentType ?? asset.mime_type;

	// Update asset to uploaded status with final metadata
	await db
		.prepare(
			`UPDATE assets SET
				status = 'uploaded',
				file_size_bytes = ?,
				mime_type = ?,
				width = COALESCE(?, width),
				height = COALESCE(?, height),
				duration_seconds = COALESCE(?, duration_seconds),
				updated_at = ?
			 WHERE id = ?`,
		)
		.bind(
			finalSize,
			finalMime,
			data.width ?? null,
			data.height ?? null,
			data.durationSeconds ?? null,
			now,
			data.assetId,
		)
		.run();

	// Fetch updated asset and return client-safe shape
	const updated = await db
		.prepare("SELECT * FROM assets WHERE id = ?")
		.bind(data.assetId)
		.first<AssetRow>();

	const clientAsset = await toClientAsset(updated!, c.env);
	return success(c, clientAsset);
});

export { uploads as mobileUploadRoutes };
