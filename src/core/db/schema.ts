/* ──────────────── Database Row Types ──────────────── */
/* These match the D1 table schemas in migrations/ */

export interface UserRow {
	id: string;
	email: string;
	display_name: string;
	avatar_url: string | null;
	auth_provider: string;
	auth_provider_id: string;
	role: "user" | "admin";
	created_at: string;
	updated_at: string;
}

export interface AssetRow {
	id: string;
	user_id: string;
	kind: "input" | "output";
	type: "image" | "video";
	status: "pending" | "uploaded" | "processing" | "ready" | "failed";
	storage_key: string;
	original_filename: string;
	mime_type: string;
	file_size_bytes: number;
	width: number | null;
	height: number | null;
	duration_seconds: number | null;
	metadata: string | null; // JSON string
	created_at: string;
	updated_at: string;
}

export interface FilterRow {
	id: string;
	name: string;
	slug: string;
	description: string;
	thumbnail_url: string;
	category: string;
	provider_model_id: string;
	config: string | null; // JSON string
	input_media_types: string; // comma-separated: "image", "video", "image,video"
	provider_name: string;
	prompt_template: string;
	default_params_json: string | null; // JSON string
	is_active: number; // SQLite boolean (0 or 1)
	sort_order: number;
	created_at: string;
	updated_at: string;
}

export interface GenerationJobRow {
	id: string;
	user_id: string;
	filter_id: string;
	input_asset_id: string;
	output_asset_id: string | null;
	status: string;
	provider_name: string | null;
	provider_job_id: string | null;
	provider_status: string | null;
	requested_params_json: string | null; // JSON string
	error_code: string | null;
	error_message: string | null;
	queued_at: string | null;
	started_at: string | null;
	completed_at: string | null;
	failed_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface DevicePushTokenRow {
	id: string;
	user_id: string;
	token: string;
	platform: "ios" | "android";
	is_active: number; // SQLite boolean
	created_at: string;
	updated_at: string;
}

export interface AdminSettingRow {
	key: string;
	value: string;
	description: string | null;
	updated_at: string;
}
