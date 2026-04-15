import type { GenerationProvider } from "../types";
import { atlasProvider } from "./atlas";
import { openrouterProvider } from "./openrouter";

const providers = new Map<string, GenerationProvider>();
providers.set(atlasProvider.name, atlasProvider);
providers.set(openrouterProvider.name, openrouterProvider);

export function getProvider(name: string): GenerationProvider | undefined {
	return providers.get(name);
}
