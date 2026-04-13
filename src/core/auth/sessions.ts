/**
 * Opaque session token management.
 *
 * Tokens are random 256-bit values prefixed with "amb_" (ai-media-bearer).
 * Only a SHA-256 hash is stored in D1 — the raw token is returned to the
 * client once at creation and never persisted on the backend.
 */

const SESSION_EXPIRY_DAYS = 90;
const TOKEN_PREFIX = "amb_";

/* ──────────────── Token helpers ──────────────── */

export async function generateToken(): Promise<{ raw: string; hash: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const raw = `${TOKEN_PREFIX}${hex}`;
	const hash = await hashToken(raw);
	return { raw, hash };
}

export async function hashToken(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/* ──────────────── Session CRUD ──────────────── */

export interface ValidatedSession {
	sessionId: string;
	userId: string;
	userStatus: string;
}

export async function createSession(
	db: D1Database,
	userId: string,
	deviceId: string | null,
): Promise<{ sessionId: string; rawToken: string; expiresAt: string }> {
	const { raw, hash } = await generateToken();
	const sessionId = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

	await db
		.prepare(
			`INSERT INTO auth_sessions (id, user_id, token_hash, device_id, is_active, expires_at, last_used_at, created_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
		)
		.bind(sessionId, userId, hash, deviceId, expiresAt.toISOString(), now.toISOString(), now.toISOString())
		.run();

	return { sessionId, rawToken: raw, expiresAt: expiresAt.toISOString() };
}

export async function validateSession(
	db: D1Database,
	token: string,
): Promise<ValidatedSession | null> {
	if (!token.startsWith(TOKEN_PREFIX)) {
		return null;
	}

	const tokenHash = await hashToken(token);

	const row = await db
		.prepare(
			`SELECT s.id AS session_id, s.user_id, s.expires_at, u.status AS user_status
			 FROM auth_sessions s
			 JOIN users u ON s.user_id = u.id
			 WHERE s.token_hash = ? AND s.is_active = 1`,
		)
		.bind(tokenHash)
		.first<{ session_id: string; user_id: string; expires_at: string | null; user_status: string }>();

	if (!row) return null;

	// Check expiry
	if (row.expires_at && new Date(row.expires_at) < new Date()) {
		// Mark expired session as inactive (best-effort cleanup)
		await db.prepare("UPDATE auth_sessions SET is_active = 0 WHERE id = ?").bind(row.session_id).run();
		return null;
	}

	if (row.user_status !== "active") {
		return null;
	}

	return {
		sessionId: row.session_id,
		userId: row.user_id,
		userStatus: row.user_status,
	};
}

export async function revokeSessionByTokenHash(db: D1Database, tokenHash: string): Promise<void> {
	await db.prepare("UPDATE auth_sessions SET is_active = 0 WHERE token_hash = ?").bind(tokenHash).run();
}

export async function touchSession(db: D1Database, sessionId: string): Promise<void> {
	await db
		.prepare("UPDATE auth_sessions SET last_used_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), sessionId)
		.run();
}
