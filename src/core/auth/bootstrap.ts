/**
 * Anonymous auth bootstrap orchestration.
 *
 * On first launch the mobile app calls POST /api/mobile/auth/bootstrap with
 * a device payload. This module either recovers an existing anonymous user
 * (best-effort, via device_identifier + platform) or creates a fresh one,
 * then issues an opaque session token.
 *
 * Recovery is intentionally conservative: if the device_identifier is missing,
 * or the linked user is not in an active state, a new user is created rather
 * than risking a wrong match. Future integrity checks (Play Integrity, App
 * Attest) can be layered in without restructuring.
 */

import type { UserRow } from "../db/schema";
import { findDeviceForRecovery, createDevice, updateDevice, type DeviceInfo } from "./devices";
import { createSession } from "./sessions";

/* ──────────────── Public types ──────────────── */

export interface BootstrapRequest {
	installation_id: string;
	platform: "ios" | "android";
	app_version: string;
	device_identifier?: string;
	device_model?: string;
	os_version?: string;
}

export interface BootstrapResponse {
	access_token: string;
	token_type: "bearer";
	expires_at: string;
	user: {
		id: string;
		is_anonymous: boolean;
		created_at: string;
	};
	device_id: string;
	recovery: {
		recovered: boolean;
		method: string | null;
	};
}

/* ──────────────── Bootstrap ──────────────── */

interface BootstrapResult {
	user: UserRow;
	deviceId: string;
	recovered: boolean;
	recoveryMethod: string | null;
}

export async function bootstrapAuth(
	db: D1Database,
	req: BootstrapRequest,
): Promise<BootstrapResponse> {
	const deviceInfo: DeviceInfo = {
		device_identifier: req.device_identifier,
		installation_id: req.installation_id,
		platform: req.platform,
		device_model: req.device_model,
		os_version: req.os_version,
		app_version: req.app_version,
	};

	let result: BootstrapResult;

	// Step 1: attempt device-based recovery
	const existingDevice = await findDeviceForRecovery(db, req.device_identifier, req.platform);

	if (existingDevice) {
		const user = await db
			.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'")
			.bind(existingDevice.user_id)
			.first<UserRow>();

		if (user) {
			// Recovery succeeded — refresh device record
			await updateDevice(db, existingDevice.id, deviceInfo);
			result = {
				user,
				deviceId: existingDevice.id,
				recovered: true,
				recoveryMethod: "device_identifier",
			};
		} else {
			// Linked user missing or inactive — start fresh
			result = await createFreshUser(db, deviceInfo);
		}
	} else {
		// No matching device — start fresh
		result = await createFreshUser(db, deviceInfo);
	}

	// Step 2: issue a session token
	const session = await createSession(db, result.user.id, result.deviceId);

	return {
		access_token: session.rawToken,
		token_type: "bearer",
		expires_at: session.expiresAt,
		user: {
			id: result.user.id,
			is_anonymous: result.user.is_anonymous === 1,
			created_at: result.user.created_at,
		},
		device_id: result.deviceId,
		recovery: {
			recovered: result.recovered,
			method: result.recoveryMethod,
		},
	};
}

/* ──────────────── Internals ──────────────── */

async function createFreshUser(db: D1Database, info: DeviceInfo): Promise<BootstrapResult> {
	const userId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO users (
				id, email, display_name, auth_provider, auth_provider_id,
				role, is_anonymous, status, created_at, updated_at
			) VALUES (?, ?, '', 'anonymous', ?, 'user', 1, 'active', ?, ?)`,
		)
		.bind(userId, `anon_${userId}@anonymous.local`, userId, now, now)
		.run();

	const deviceId = await createDevice(db, userId, info);

	const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();

	return {
		user: user!,
		deviceId,
		recovered: false,
		recoveryMethod: null,
	};
}
