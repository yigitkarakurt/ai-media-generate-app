import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

// Setup files run outside isolated storage and may run multiple times.
// applyD1Migrations() is idempotent, so this safely prepares each test worker.
await applyD1Migrations(env.DB, env.MIGRATIONS);
