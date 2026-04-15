import { AppError } from "../../../../../shared/errors";
import type { DispatchContext } from "../../../types";
import type {
	ModelAdapter,
	OpenRouterChatRequest,
	OperationType,
} from "../types";

/**
 * Model adapter for bytedance-seed/seedream-4.5 via OpenRouter.
 *
 * Supported operations:
 *   text_to_image  — sends a text content block only
 *   image_to_image — sends a text block + one image_url block
 *
 * Multi-image note:
 *   This adapter currently uses only the PRIMARY input image
 *   (inputImageUrls[0]) for image_to_image. The DispatchRequest already
 *   carries inputImageUrls as an array, so multi-image reference behavior
 *   is architecturally supported but is deferred to a future iteration.
 */
export class Seedream45Adapter implements ModelAdapter {
	readonly modelKey = "bytedance-seed/seedream-4.5";

	buildRequest(ctx: DispatchContext): OpenRouterChatRequest {
		const { request } = ctx;
		const operationType = resolveOperationType(request.filterConfig);

		if (operationType === "image_to_image") {
			// Validate that we have at least one signed input image URL
			const primaryImageUrl = request.inputImageUrls[0];
			if (!primaryImageUrl) {
				throw AppError.badRequest(
					"IMAGE_TO_IMAGE_NO_INPUT",
					"image_to_image operation requires an input image but none was available.",
				);
			}

			console.log(
				`[openrouter:seedream-4.5] image_to_image — using primary input image only ` +
				`(${request.inputImageUrls.length} URL(s) available; multi-image deferred)`,
			);

			return {
				model: this.modelKey,
				modalities: ["image"],
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: request.prompt },
							{
								type: "image_url",
								image_url: { url: primaryImageUrl },
							},
						],
					},
				],
			};
		}

		// text_to_image (default)
		return {
			model: this.modelKey,
			modalities: ["image"],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: request.prompt }],
				},
			],
		};
	}
}

/* ──────────────── Helpers ──────────────── */

function resolveOperationType(
	filterConfig: Record<string, unknown> | null,
): OperationType {
	const raw = filterConfig?.["operation_type"];
	if (raw === "image_to_image") return "image_to_image";
	// Default: text_to_image
	return "text_to_image";
}
