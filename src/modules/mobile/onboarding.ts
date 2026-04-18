import { Hono } from "hono";
import type { AppEnv } from "../../bindings";
import { success } from "../../shared/api-response";
import type { OnboardingFlowRow, OnboardingScreenRow } from "../../core/db/schema";

function toClientScreen(row: OnboardingScreenRow) {
	return {
		id: row.id,
		title: row.title,
		subtitle: row.subtitle,
		description: row.description,
		media_type: row.media_type,
		media_url: row.media_url,
		cta_text: row.cta_text,
		secondary_cta_text: row.secondary_cta_text,
		sort_order: row.sort_order,
	};
}

const onboarding = new Hono<AppEnv>();

/** Public onboarding endpoint — no auth required (called before login). */
onboarding.get("/", async (c) => {
	const db = c.env.DB;

	const flow = await db
		.prepare("SELECT * FROM onboarding_flows WHERE is_active = 1 LIMIT 1")
		.first<OnboardingFlowRow>();

	if (!flow) {
		return success(c, { flow: null, screens: [] });
	}

	const screens = await db
		.prepare(
			`SELECT * FROM onboarding_screens
			 WHERE flow_id = ? AND is_active = 1
			 ORDER BY sort_order ASC`,
		)
		.bind(flow.id)
		.all<OnboardingScreenRow>();

	return success(c, {
		flow: {
			id: flow.id,
			key: flow.key,
			name: flow.name,
		},
		screens: screens.results.map(toClientScreen),
	});
});

export { onboarding as mobileOnboardingRoutes };
