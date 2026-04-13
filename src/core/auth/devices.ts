/**
 * Device record management for anonymous auth recovery.
 *
 * device_identifier (e.g. Android ID, identifierForVendor) is treated as a
 * best-effort recovery signal — it can change after factory reset, may be
 * absent on some devices, and should never be trusted as sole proof of
 * identity. The recovery logic is intentionally conservative.
 */

import type { UserDeviceRow } from "../db/schema";

export interface DeviceInfo {
	device_identifier?: string;
	installation_id: string;
	platform: "ios" | "android";
	device_model?: string;
	os_version?: string;
	app_version: string;
}

/**
 * Find a known device for recovery using device_identifier + platform.
 *
 * Returns the most recently seen active match, or null.
 * Skips recovery entirely when device_identifier is absent.
 */
export async function findDeviceForRecovery(
	db: D1Database,
	deviceIdentifier: string | undefined,
	platform: string,
): Promise<UserDeviceRow | null> {
	if (!deviceIdentifier) return null;

	return db
		.prepare(
			`SELECT * FROM user_devices
			 WHERE device_identifier = ? AND platform = ? AND is_active = 1
			 ORDER BY last_seen_at DESC
			 LIMIT 1`,
		)
		.bind(deviceIdentifier, platform)
		.first<UserDeviceRow>();
}

/**
 * Insert a new device record linked to a user.
 */
export async function createDevice(db: D1Database, userId: string, info: DeviceInfo): Promise<string> {
	const deviceId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO user_devices (
				id, user_id, device_identifier, installation_id, platform,
				device_model, os_version, app_version,
				is_active, first_seen_at, last_seen_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
		)
		.bind(
			deviceId,
			userId,
			info.device_identifier ?? null,
			info.installation_id,
			info.platform,
			info.device_model ?? null,
			info.os_version ?? null,
			info.app_version,
			now,
			now,
			now,
			now,
		)
		.run();

	return deviceId;
}

/**
 * Refresh an existing device record with the latest client-reported info.
 */
export async function updateDevice(db: D1Database, deviceId: string, info: DeviceInfo): Promise<void> {
	const now = new Date().toISOString();

	await db
		.prepare(
			`UPDATE user_devices SET
				installation_id = ?,
				device_model = COALESCE(?, device_model),
				os_version = COALESCE(?, os_version),
				app_version = ?,
				last_seen_at = ?,
				updated_at = ?
			 WHERE id = ?`,
		)
		.bind(
			info.installation_id,
			info.device_model ?? null,
			info.os_version ?? null,
			info.app_version,
			now,
			now,
			deviceId,
		)
		.run();
}
