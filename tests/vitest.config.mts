import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const migrationsPath = path.join(rootDir, "migrations");
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: path.join(rootDir, "wrangler.jsonc"),
			},
			miniflare: {
				compatibilityFlags: ["experimental"],
				bindings: {
					MIGRATIONS: migrations,
					ENVIRONMENT: "test",
					ADMIN_PANEL_ORIGIN: "https://ai-media-generate-admin.pages.dev",
					ADMIN_API_KEY: "test-admin-key",
					INTERNAL_API_KEY: "test-internal-key",
					REVENUECAT_WEBHOOK_SECRET: "test-revenuecat-secret",
					ATLASCLOUD_API_KEY: "test-atlas-key",
					OPENROUTER_API_KEY: "test-openrouter-key",
					R2_ACCESS_KEY_ID: "test-r2-access-key",
					R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
					R2_ACCOUNT_ID: "test-r2-account",
					R2_BUCKET_NAME: "ai-media-assets-test",
				},
			},
		}),
	],
	test: {
		setupFiles: ["./tests/apply-migrations.ts"],
	},
});
