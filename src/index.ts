import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "./bindings";
import { AppError } from "./shared/errors";
import { errorResponse } from "./shared/api-response";

// Module routes
import { healthRoutes } from "./modules/health/routes";
import { mobileFilterRoutes } from "./modules/mobile/filters";
import { mobileGenerationRoutes } from "./modules/mobile/generations";
import { mobileUploadRoutes } from "./modules/mobile/uploads";
import { mobileAssetRoutes } from "./modules/mobile/assets";
import { mobileDeviceRoutes } from "./modules/mobile/devices";
import { mobileAuthRoutes } from "./modules/mobile/auth";
import { mobileHomeRoutes } from "./modules/mobile/home";
import { mobileCategoryRoutes } from "./modules/mobile/categories";
import { adminDashboardRoutes } from "./modules/admin/dashboard";
import { adminUserRoutes } from "./modules/admin/users";
import { adminJobRoutes } from "./modules/admin/jobs";
import { adminAssetRoutes } from "./modules/admin/assets";
import { adminFilterRoutes } from "./modules/admin/filters";
import { adminTagRoutes } from "./modules/admin/tags";
import { adminCategoryRoutes } from "./modules/admin/categories";
import { adminSettingRoutes } from "./modules/admin/settings";
import { internalGenerationRoutes } from "./modules/internal/generations";
import { mobileBillingRoutes } from "./modules/mobile/billing";
import { adminBillingRoutes } from "./modules/admin/billing";
import { adminTrackingRoutes } from "./modules/admin/tracking";
import { mobileOnboardingRoutes } from "./modules/mobile/onboarding";
import { adminOnboardingRoutes } from "./modules/admin/onboarding";
import { revenuecatWebhookRoutes } from "./modules/webhooks/revenuecat";
import { handleScheduled } from "./core/generation/scheduled";
import { requireAdmin } from "./middleware/admin-auth";
import { adminCors, handleAdminPreflight } from "./middleware/admin-cors";
import { requireInternal } from "./middleware/internal-auth";

const app = new Hono<AppEnv>();

/* ──────────────── Global error handler ──────────────── */

app.onError((err, c) => {
	if (err instanceof AppError) {
		return errorResponse(c, err);
	}

	if (err instanceof ZodError) {
		return errorResponse(
			c,
			AppError.badRequest("VALIDATION_ERROR", "Request validation failed", err.flatten()),
		);
	}

	console.error("Unhandled error:", err);
	return errorResponse(c, AppError.internal());
});

/* ──────────────── Not found handler ──────────────── */

app.notFound((c) => {
	return errorResponse(c, AppError.notFound("Route"));
});

/* ──────────────── Routes ──────────────── */

// Public
app.route("/api", healthRoutes);

// Mobile client routes
app.route("/api/mobile/auth", mobileAuthRoutes);
app.route("/api/mobile/home", mobileHomeRoutes);
app.route("/api/mobile/filters", mobileFilterRoutes);
app.route("/api/mobile/categories", mobileCategoryRoutes);
app.route("/api/mobile/generations", mobileGenerationRoutes);
app.route("/api/mobile/uploads", mobileUploadRoutes);
app.route("/api/mobile/assets", mobileAssetRoutes);
app.route("/api/mobile/devices", mobileDeviceRoutes);
app.route("/api/mobile/billing", mobileBillingRoutes);
app.route("/api/mobile/onboarding", mobileOnboardingRoutes);

// Admin panel routes (all require admin key)
app.use("/api/admin/*", adminCors);
app.options("/api/admin/*", handleAdminPreflight);
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin/dashboard", adminDashboardRoutes);
app.route("/api/admin/users", adminUserRoutes);
app.route("/api/admin/jobs", adminJobRoutes);
app.route("/api/admin/assets", adminAssetRoutes);
app.route("/api/admin/filters", adminFilterRoutes);
app.route("/api/admin/tags", adminTagRoutes);
app.route("/api/admin/categories", adminCategoryRoutes);
app.route("/api/admin/settings", adminSettingRoutes);
app.route("/api/admin/billing", adminBillingRoutes);
app.route("/api/admin/tracking", adminTrackingRoutes);
app.route("/api/admin/onboarding", adminOnboardingRoutes);

// Internal routes (service-to-service, require shared secret)
app.use("/api/internal/*", requireInternal);
app.route("/api/internal/generations", internalGenerationRoutes);

// Webhook routes (external service callbacks, not client-facing)
app.route("/api/webhooks/revenuecat", revenuecatWebhookRoutes);

export default {
	fetch: app.fetch,
	scheduled: handleScheduled,
};
