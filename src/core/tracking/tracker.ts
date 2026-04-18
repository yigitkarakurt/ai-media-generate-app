/**
 * Lightweight server-side event tracking helper.
 *
 * Two exports:
 *  - extractRequestContext() — pulls IP / UA / path / method from a Hono request
 *  - trackEvent()           — fire-and-forget D1 insert; never throws
 *
 * Design principles:
 *  - Tracking failures must never break real business flows → errors are caught + logged only.
 *  - Keep metadata payloads small. Do not log secrets, tokens, or raw bodies.
 *  - Functions are pure helpers; no state, no caching.
 */

import type { HonoRequest } from "hono";

/* ──────────────── Request context ──────────────── */

export interface RequestContext {
	ip_address: string | null;
	user_agent: string | null;
	path: string | null;
	method: string | null;
}

/**
 * Extract safe request metadata from a Hono request.
 * Reads CF-Connecting-IP (set by Cloudflare) with fallback to X-Forwarded-For.
 */
export function extractRequestContext(req: HonoRequest): RequestContext {
	const ip =
		req.header("CF-Connecting-IP") ??
		req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
		null;

	return {
		ip_address: ip,
		user_agent: req.header("User-Agent") ?? null,
		path: new URL(req.url).pathname,
		method: req.method,
	};
}

/* ──────────────── trackEvent ──────────────── */

export interface TrackEventOptions {
	/** Authenticated user ID if known. */
	user_id?: string | null;
	/** Output of extractRequestContext(). Omit for scheduled/background events. */
	ctx?: RequestContext | null;
	/** 'ios' | 'android' if available at call site. */
	platform?: string | null;
	/** App version string if available at call site. */
	app_version?: string | null;
	/**
	 * Small, scoped business metadata.
	 * Keep keys minimal — do NOT include secrets, tokens, or large blobs.
	 */
	metadata?: Record<string, unknown> | null;
}

/**
 * Write a tracking event row to D1.
 *
 * Fire-and-forget: any D1 error is caught and logged; it never propagates.
 * This ensures a tracking failure cannot break a user-facing request.
 */
export async function trackEvent(
	db: D1Database,
	event_name: string,
	opts: TrackEventOptions = {},
): Promise<void> {
	try {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const metadataStr =
			opts.metadata && Object.keys(opts.metadata).length > 0
				? JSON.stringify(opts.metadata)
				: null;

		await db
			.prepare(
				`INSERT INTO tracking_events (
					id, user_id, event_name,
					ip_address, user_agent, path, method,
					platform, app_version, metadata, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				opts.user_id ?? null,
				event_name,
				opts.ctx?.ip_address ?? null,
				opts.ctx?.user_agent ?? null,
				opts.ctx?.path ?? null,
				opts.ctx?.method ?? null,
				opts.platform ?? null,
				opts.app_version ?? null,
				metadataStr,
				now,
			)
			.run();
	} catch (err) {
		// Tracking is best-effort — log and continue.
		console.error(`[tracking] insert failed for event="${event_name}":`, err);
	}
}
