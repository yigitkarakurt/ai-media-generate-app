import { z } from "zod";

export const paginationQuery = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export const uuidParam = z.object({
	id: z.string().uuid(),
});

/** Parse query params with a Zod schema. Throws AppError on failure. */
export function parseQuery<T extends z.ZodTypeAny>(
	url: string,
	schema: T,
): z.infer<T> {
	const searchParams = new URL(url).searchParams;
	const raw: Record<string, string> = {};
	for (const [key, value] of searchParams.entries()) {
		raw[key] = value;
	}
	return schema.parse(raw);
}
