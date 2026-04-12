import type { GenerationProvider } from "../types";
import { atlasProvider } from "./atlas";

const providers = new Map<string, GenerationProvider>();
providers.set(atlasProvider.name, atlasProvider);

export function getProvider(name: string): GenerationProvider | undefined {
	return providers.get(name);
}
