# Postman Collection

Postman collection and environment for testing the AI Media Generate backend.

## Files

| File | Description |
|------|-------------|
| `ai-media-generate-app.postman_collection.json` | Full API collection (v2.1, 79 requests) |
| `local-dev.postman_environment.json` | Local development environment variables |

## Import

1. Start the Worker: `npm run dev`
2. In Postman: **Import** > select `ai-media-generate-app.postman_collection.json`
3. **Import** > select `local-dev.postman_environment.json`
4. Select the **AI Media — Local Dev** environment in the top-right dropdown

## Variables to Set

Most variables are auto-populated by test scripts. Set these before you start:

| Variable | Default | Notes |
|----------|---------|-------|
| `baseUrl` | `http://localhost:8787` | Your local Worker URL |
| `adminApiKey` | `test-admin-key` | Must match `ADMIN_API_KEY` in `.dev.vars` (or skip if dev mode) |
| `internalApiKey` | `test-internal-key` | Must match `INTERNAL_API_KEY` in `.dev.vars` (always required) |
| `revenuecatWebhookSecret` | `test-webhook-secret` | Must match `REVENUECAT_WEBHOOK_SECRET` in `.dev.vars` |

Variables auto-set by test scripts: `authToken`, `userId`, `filterId`, `filterSlug`, `categoryId`, `categorySlug`, `tagId`, `previewId`, `assetId`, `uploadUrl`, `storageKey`, `generationId`, `jobId`, `billingProductId`, `onboardingFlowId`, `onboardingScreenId`.

## Authentication

### Mobile Auth (Bearer Token)

Mobile routes use `Authorization: Bearer {session_token}`.

1. Run **Mobile > Auth > Bootstrap**
2. The test script auto-sets `authToken` and `userId`
3. All mobile requests in the folder inherit this Bearer token

To get a fresh token, run Bootstrap again. To invalidate it, run **Logout**.

### Admin Auth (X-Admin-Key)

Admin routes use the `X-Admin-Key` header, set at the folder level via API Key auth type.

Set `adminApiKey` in the environment to match your `ADMIN_API_KEY` Worker secret. In `development` and `test` environments with no key configured, admin routes are open.

### Internal Auth (X-Internal-Key)

Internal routes use the `X-Internal-Key` header. This is always required, even in dev mode.

Set `internalApiKey` in the environment to match your `INTERNAL_API_KEY` Worker secret.

### Webhook Auth

The RevenueCat webhook uses `Authorization: Bearer {secret}`. The request in the Webhooks folder is pre-configured with `{{revenuecatWebhookSecret}}` as the Bearer token.

## Upload Flow

Uploads use presigned R2 URLs (the Worker never proxies file bytes):

```
1. POST /api/mobile/uploads/request   → get assetId + uploadUrl
2. PUT  {uploadUrl}                   → upload file binary to R2
3. POST /api/mobile/uploads/confirm   → mark asset as uploaded
```

Step 2 goes directly to R2, not to the Worker. In Postman:

1. Run **Mobile > Uploads > Request Upload URL** (auto-captures `assetId` and `uploadUrl`)
2. Run **Mobile > Uploads > Upload File to R2 (manual)** — go to Body > Binary and select a local image file
3. Run **Mobile > Uploads > Confirm Upload**

The signed URL expires in ~600 seconds. Re-run step 1 if it expires.

## Home / Catalog Testing

After seeding data (via migrations or admin APIs):

1. **Mobile > Home > Get Home** — returns featured filters and home category sections
2. **Mobile > Categories > List Categories** — all active categories
3. **Mobile > Categories > Category Filters** — paginated filters for a category (uses `{{categorySlug}}`)
4. **Mobile > Filters > List Filters** — all active filters with primary preview
5. **Mobile > Filters > Filter Detail** — single filter with full preview gallery and categories (uses `{{filterSlug}}`)

The seeded data includes 4 filters, 5 categories, 9 tags, and 11 filter previews.

## Webhook Testing

Use **Webhooks > RevenueCat Webhook** to simulate purchase events. The default body is a `NON_RENEWING_PURCHASE` for a coin pack. Change `event.type` for other scenarios:

| Event Type | Effect |
|------------|--------|
| `INITIAL_PURCHASE` | Activate subscription entitlement |
| `RENEWAL` | Refresh subscription |
| `NON_RENEWING_PURCHASE` | Grant coins from coin pack |
| `CANCELLATION` | Mark subscription as cancelled / refund coin pack |
| `EXPIRATION` | Deactivate subscription |

Prerequisites for webhook testing:
1. A billing product must exist (run **Admin > Billing > Create Billing Product**)
2. The user must have a billing customer record (run **Mobile > Billing > Register Customer**)
3. The `rc_app_user_id` in the webhook body must match the registered customer

## Onboarding Testing

The onboarding endpoint is public (no auth required) — it's called before login.

1. **Mobile > Onboarding > Get Onboarding** — returns active flow + ordered screens (auto-sets `onboardingFlowId`)

To manage onboarding via admin:

1. **Admin > Onboarding > Create Flow** — create a new flow (auto-sets `onboardingFlowId`)
2. **Admin > Onboarding > Create Screen** — add screens to the flow (auto-sets `onboardingScreenId`)
3. **Admin > Onboarding > Update Screen** — edit title, media, sort order, active state
4. **Admin > Onboarding > List Screens** — view all screens (enable `flow_id` query param to filter)
5. **Mobile > Onboarding > Get Onboarding** — verify the mobile response

Activating a flow via **Create Flow** or **Update Flow** with `is_active: true` automatically deactivates all other flows.

Supported `media_type` values: `image`, `gif`, `video`.

## Recommended Test Order

### Quick smoke test
1. **Health > Health Check** — verify Worker is running
2. **Mobile > Auth > Bootstrap** — get auth token
3. **Mobile > Home > Get Home** — see seeded catalog data
4. **Mobile > Filters > List Filters** — browse filters

### Full end-to-end flow
1. **Health > Health Check**
2. **Mobile > Auth > Bootstrap** (auto-sets `authToken`, `userId`)
3. **Mobile > Home > Get Home**
4. **Mobile > Categories > List Categories**
5. **Mobile > Categories > Category Filters**
6. **Mobile > Filters > List Filters** (auto-sets `filterId`, `filterSlug`)
7. **Mobile > Filters > Filter Detail**
8. **Admin > Billing > Create Billing Product** (auto-sets `billingProductId`)
9. **Admin > Billing > Grant Coins** — give user coins for generation
10. **Mobile > Billing > Get Billing State** — verify coins
11. **Mobile > Uploads > Request Upload URL** (auto-sets `assetId`, `uploadUrl`)
12. **Mobile > Uploads > Upload File to R2 (manual)** — select a file
13. **Mobile > Uploads > Confirm Upload**
14. **Mobile > Generations > Create Generation** (auto-sets `generationId`)
15. **Mobile > Generations > Get Generation Detail** — poll for completion
16. **Internal > Sync Single Job** — trigger provider sync if needed
17. **Mobile > Billing > Get Coin Balance** — verify deduction

### Admin catalog management
1. **Admin > Tags > Create Tag** (auto-sets `tagId`)
2. **Admin > Categories > Create Category** (auto-sets `categoryId`)
3. **Admin > Filters > Create Filter** (auto-sets `filterId`)
4. **Admin > Filters > Add Filter Preview** (auto-sets `previewId`)
5. **Admin > Filters > Add Filter to Category** — link filter to category
6. **Admin > Categories > Set Category Filters (bulk)** — bulk assign
7. **Mobile > Home > Get Home** — verify everything appears

## Collection Structure

```
Health                          (public, no auth)
Mobile                          (Bearer token auth)
├── Auth                        (Bootstrap is public)
├── Onboarding                  (public, no auth — pre-login)
├── Home                        (featured + categories)
├── Categories                  (browse + category filters)
├── Filters                     (list + detail with previews)
├── Uploads                     (request → upload → confirm)
├── Assets                      (list + get)
├── Generations                 (create + list + detail)
├── Billing                     (coins, subscriptions, products)
└── Devices                     (push tokens — not yet implemented)
Admin                           (X-Admin-Key auth)
├── Dashboard
├── Users
├── Jobs
├── Assets
├── Tags
├── Categories                  (CRUD + filter assignments)
├── Filters                     (CRUD + previews + category links)
├── Billing                     (products, coins, events)
├── Settings
└── Onboarding                  (flows + screens CRUD)
Internal                        (X-Internal-Key auth)
└── Generation sync
Webhooks
└── RevenueCat
```
