import type { AppBindings } from "../../bindings";
import { AppError } from "../../shared/errors";
import { getProvider } from "./providers";
import type { DispatchContext, DispatchRequest, DispatchResult } from "./types";

/**
 * Provider routing layer.
 *
 * Resolves the correct provider adapter from the request's providerName,
 * then delegates submission to that adapter.
 */
export async function dispatchGeneration(
	request: DispatchRequest,
	env: AppBindings,
): Promise<DispatchResult> {
	const provider = getProvider(request.providerName);

	if (!provider) {
		console.error(
			`[dispatch] No provider registered for "${request.providerName}" (job ${request.jobId})`,
		);
		throw AppError.internal("Generation service is not configured for this filter");
	}

	console.log(
		`[dispatch] Job ${request.jobId} → provider "${provider.name}" (model: ${request.filterModelId})`,
	);

	const ctx: DispatchContext = { request, env };
	return provider.submit(ctx);
}
