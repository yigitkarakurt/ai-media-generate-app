import type { D1Migration } from "cloudflare:test";
import type { AppBindings } from "../src/bindings";

export type TestEnv = AppBindings & {
	MIGRATIONS: D1Migration[];
};

declare global {
	namespace Cloudflare {
		interface Env extends TestEnv {}
	}
}

declare module "cloudflare:test" {
	interface ProvidedEnv extends TestEnv {}
}
