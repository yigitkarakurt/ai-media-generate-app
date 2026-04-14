export class AppError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number = 500,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "AppError";
	}

	static badRequest(code: string, message: string, details?: unknown) {
		return new AppError(code, message, 400, details);
	}

	static unauthorized(message = "Unauthorized") {
		return new AppError("UNAUTHORIZED", message, 401);
	}

	static forbidden(message = "Forbidden") {
		return new AppError("FORBIDDEN", message, 403);
	}

	static notFound(resource = "Resource") {
		return new AppError("NOT_FOUND", `${resource} not found`, 404);
	}

	static conflict(message: string) {
		return new AppError("CONFLICT", message, 409);
	}

	static tooManyRequests(message = "Too many requests, please try again later") {
		return new AppError("RATE_LIMITED", message, 429);
	}

	static internal(message = "Internal server error") {
		return new AppError("INTERNAL_ERROR", message, 500);
	}
}
