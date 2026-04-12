import type { D1Migration } from "cloudflare:test";
import type { AppBindings } from "../src/bindings";

export type Env = AppBindings & {
	MIGRATIONS: D1Migration[];
};

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
