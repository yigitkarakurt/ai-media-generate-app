import type { Context } from "hono";

export interface AppBindings {
	DB: D1Database;
	MEDIA_BUCKET: R2Bucket;
	JWT_SECRET: string;
	ENVIRONMENT: string;
	// R2 S3-compatible API credentials (for presigned URLs via aws4fetch)
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_ACCOUNT_ID: string;
	R2_BUCKET_NAME: string;
	// Provider API keys
	ATLASCLOUD_API_KEY: string;
	OPENROUTER_API_KEY: string;
	// RevenueCat webhook verification
	REVENUECAT_WEBHOOK_SECRET: string;
	// Admin API key (set via `wrangler secret put ADMIN_API_KEY`)
	ADMIN_API_KEY: string;
	// Internal service-to-service auth key (set via `wrangler secret put INTERNAL_API_KEY`)
	INTERNAL_API_KEY: string;
}

export interface AppEnv {
	Bindings: AppBindings;
}

export type AppContext = Context<AppEnv>;
