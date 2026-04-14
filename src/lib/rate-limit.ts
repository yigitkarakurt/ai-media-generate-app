/**
 * In-memory fixed-window rate limiter for Cloudflare Workers.
 *
 * Each Worker isolate maintains its own rate counters. Since Cloudflare
 * reuses isolates for many sequential requests, this provides meaningful
 * protection against sustained abuse from a single source — even though
 * it won't share state across globally distributed isolates.
 *
 * This is intentionally simple: no external dependencies, no D1 writes,
 * near-zero latency overhead.
 */

interface RateLimitEntry {
	count: number;
	/** Window start timestamp (ms) */
	windowStart: number;
}

interface RateLimitConfig {
	/** Max requests allowed per window */
	maxRequests: number;
	/** Window size in seconds */
	windowSeconds: number;
}

/** Global stores keyed by limiter name → request key → entry */
const stores = new Map<string, Map<string, RateLimitEntry>>();

/** Last cleanup timestamp per store */
const lastCleanup = new Map<string, number>();

/** Minimum interval between cleanup sweeps (ms) */
const CLEANUP_INTERVAL_MS = 60_000;

function getOrCreateStore(name: string): Map<string, RateLimitEntry> {
	let store = stores.get(name);
	if (!store) {
		store = new Map();
		stores.set(name, store);
	}
	return store;
}

/**
 * Evict expired entries periodically to prevent unbounded memory growth.
 * Only runs at most once per CLEANUP_INTERVAL_MS per store.
 */
function maybeCleanup(name: string, store: Map<string, RateLimitEntry>, windowMs: number): void {
	const now = Date.now();
	const last = lastCleanup.get(name) ?? 0;
	if (now - last < CLEANUP_INTERVAL_MS) return;

	lastCleanup.set(name, now);
	const cutoff = now - windowMs;
	for (const [key, entry] of store) {
		if (entry.windowStart < cutoff) {
			store.delete(key);
		}
	}
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	resetAt: number; // Unix timestamp (seconds) when the window resets
}

/**
 * Check and consume a rate limit token.
 *
 * @param name - Unique limiter name (e.g., "bootstrap", "upload-request")
 * @param key - Per-caller key (e.g., IP address or userId)
 * @param config - Rate limit configuration
 * @returns Whether the request is allowed + remaining quota info
 */
export function checkRateLimit(
	name: string,
	key: string,
	config: RateLimitConfig,
): RateLimitResult {
	const store = getOrCreateStore(name);
	const windowMs = config.windowSeconds * 1000;
	const now = Date.now();

	maybeCleanup(name, store, windowMs);

	const entry = store.get(key);

	// No entry or window expired → start fresh
	if (!entry || now - entry.windowStart >= windowMs) {
		store.set(key, { count: 1, windowStart: now });
		return {
			allowed: true,
			remaining: config.maxRequests - 1,
			resetAt: Math.ceil((now + windowMs) / 1000),
		};
	}

	// Within window
	if (entry.count < config.maxRequests) {
		entry.count += 1;
		return {
			allowed: true,
			remaining: config.maxRequests - entry.count,
			resetAt: Math.ceil((entry.windowStart + windowMs) / 1000),
		};
	}

	// Rate limit exceeded
	return {
		allowed: false,
		remaining: 0,
		resetAt: Math.ceil((entry.windowStart + windowMs) / 1000),
	};
}

/**
 * Reset a specific key's rate limit. Useful in tests.
 */
export function resetRateLimit(name: string, key?: string): void {
	if (key) {
		stores.get(name)?.delete(key);
	} else {
		stores.delete(name);
		lastCleanup.delete(name);
	}
}

/**
 * Reset ALL rate limiters. Useful in tests.
 */
export function resetAllRateLimits(): void {
	stores.clear();
	lastCleanup.clear();
}
