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
	is_anonymous: number; // SQLite boolean (0 or 1)
	status: string; // 'active' | 'suspended' | 'deleted'
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
	coin_cost: number; // 0 means free
	tag_id: string | null;
	preview_image_url: string;
	model_key: string;
	operation_type: "text_to_image" | "image_to_image" | string;
	is_featured: number; // SQLite boolean (0 or 1)
	sort_order: number;
	created_at: string;
	updated_at: string;
}

export interface TagRow {
	id: string;
	slug: string;
	name: string;
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

/* ──────────────── Billing Row Types ──────────────── */

export interface BillingCustomerRow {
	id: string;
	user_id: string;
	rc_app_user_id: string;
	created_at: string;
	updated_at: string;
}

export interface BillingProductRow {
	id: string;
	rc_product_id: string;
	type: "subscription" | "coin_pack";
	name: string;
	coin_amount: number | null;
	entitlement_id: string | null;
	is_active: number; // SQLite boolean (0 or 1)
	created_at: string;
	updated_at: string;
}

export interface UserEntitlementRow {
	id: string;
	user_id: string;
	entitlement_id: string;
	rc_product_id: string;
	is_active: number; // SQLite boolean (0 or 1)
	expires_at: string | null;
	original_purchase_at: string | null;
	last_renewed_at: string | null;
	unsubscribed_at: string | null;
	billing_issue_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface BillingEventRow {
	id: string;
	rc_event_id: string;
	event_type: string;
	rc_product_id: string | null;
	user_id: string | null;
	payload: string; // JSON string
	processed_at: string;
	created_at: string;
}

export interface CoinLedgerRow {
	id: string;
	user_id: string;
	amount: number;
	reason: "purchase" | "generation_debit" | "refund" | "admin_grant" | "admin_debit" | "bonus";
	billing_event_id: string | null;
	description: string;
	created_at: string;
}

export interface UserWalletRow {
	user_id: string;
	balance: number;
	updated_at: string;
}

/* ──────────────── Auth Row Types ──────────────── */

export interface UserDeviceRow {
	id: string;
	user_id: string;
	device_identifier: string | null;
	installation_id: string | null;
	platform: "ios" | "android";
	device_model: string | null;
	os_version: string | null;
	app_version: string | null;
	integrity_level: string | null;
	integrity_checked_at: string | null;
	risk_score: number | null;
	device_attestation_status: string | null;
	is_active: number;
	first_seen_at: string;
	last_seen_at: string;
	created_at: string;
	updated_at: string;
}

export interface AuthSessionRow {
	id: string;
	user_id: string;
	token_hash: string;
	device_id: string | null;
	is_active: number;
	expires_at: string | null;
	last_used_at: string;
	created_at: string;
}

export interface AuthIdentityRow {
	id: string;
	user_id: string;
	provider: string;
	provider_id: string;
	provider_email: string | null;
	provider_metadata: string | null;
	linked_at: string;
	created_at: string;
	updated_at: string;
}
