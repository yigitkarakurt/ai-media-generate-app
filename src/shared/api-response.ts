import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "./errors";

/* ──────────────── Response shapes ──────────────── */

export interface SuccessResponse<T> {
	success: true;
	data: T;
}

export interface ErrorResponse {
	success: false;
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
}

export interface PaginationMeta {
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
}

export interface PaginatedResponse<T> {
	success: true;
	data: T[];
	pagination: PaginationMeta;
}

/* ──────────────── Response helpers ──────────────── */

export function success<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
	return c.json<SuccessResponse<T>>({ success: true, data }, status);
}

export function paginated<T>(
	c: Context,
	data: T[],
	pagination: PaginationMeta,
) {
	return c.json<PaginatedResponse<T>>({
		success: true,
		data,
		pagination,
	});
}

export function errorResponse(c: Context, err: AppError) {
	return c.json<ErrorResponse>(
		{
			success: false,
			error: {
				code: err.code,
				message: err.message,
				details: err.details,
			},
		},
		err.status as ContentfulStatusCode,
	);
}
