import type { FilterPreviewRow } from "../../core/db/schema";

export interface ClientPreview {
	id: string;
	preview_url: string;
	media_type: string;
	sort_order: number;
}

export function toClientPreview(row: FilterPreviewRow): ClientPreview {
	return {
		id: row.id,
		preview_url: row.preview_url,
		media_type: row.media_type,
		sort_order: row.sort_order,
	};
}

type PreviewLookupRow = Pick<FilterPreviewRow, "id" | "filter_id" | "preview_url" | "media_type" | "sort_order">;

/**
 * Bulk-fetch previews for a set of filter ids, grouped by filter_id.
 * Each group is ordered by sort_order ASC. Returns an empty map for empty input.
 */
export async function fetchPreviewsByFilterIds(
	db: D1Database,
	ids: readonly string[],
): Promise<Map<string, ClientPreview[]>> {
	const grouped = new Map<string, ClientPreview[]>();
	if (ids.length === 0) return grouped;

	// Deduplicate to keep the IN-list small on home responses where featured
	// and category sections overlap.
	const unique = Array.from(new Set(ids));
	const placeholders = unique.map(() => "?").join(", ");

	const { results } = await db
		.prepare(
			`SELECT id, filter_id, preview_url, media_type, sort_order
			FROM filter_previews
			WHERE filter_id IN (${placeholders})
			ORDER BY filter_id, sort_order ASC`,
		)
		.bind(...unique)
		.all<PreviewLookupRow>();

	for (const row of results) {
		const bucket = grouped.get(row.filter_id);
		const preview = toClientPreview(row as FilterPreviewRow);
		if (bucket) bucket.push(preview);
		else grouped.set(row.filter_id, [preview]);
	}
	return grouped;
}

export function attachPreviews<T extends { id: string }>(
	items: T[],
	map: Map<string, ClientPreview[]>,
): (T & { previews: ClientPreview[] })[] {
	return items.map((item) => ({ ...item, previews: map.get(item.id) ?? [] }));
}
