# Postman Artifacts

Postman collection and environment for manually testing the AI Media Generate Cloudflare Workers backend.

## Files

| File | Description |
|------|-------------|
| `ai-media-generate-app.postman_collection.json` | Full API collection (v2.1) |
| `local-dev.postman_environment.json` | Local development environment variables |

## Import

1. Start the Worker locally: `npm run dev`
2. In Postman, **Import** > select `postman/ai-media-generate-app.postman_collection.json`
3. **Import** > select `postman/local-dev.postman_environment.json`
4. Select the **AI Media Generate App - Local Dev** environment in the top-right dropdown

## Variables to Set Manually

Most variables are auto-populated by test scripts during the flow. A few must be set before you start:

| Variable | Where | Notes |
|----------|-------|-------|
| `baseUrl` | Environment | Default `http://127.0.0.1:8787` — change if your local port differs |
| `adminApiKey` | Environment | Must match `ADMIN_API_KEY` in your `.dev.vars` / Worker secrets |
| `revenuecatWebhookSecret` | Environment | Must match `REVENUECAT_WEBHOOK_SECRET` in your `.dev.vars` / Worker secrets |
| `atlasModelId` | Environment | Only needed if you create a filter via Admin and run live generation |
| `installationId` | Environment | Pre-filled; change if you want a different installation |

**Do not add Atlas API keys to Postman.** The backend reads `ATLASCLOUD_API_KEY` from Worker secrets; clients never send it.

## Authentication

### Mobile Auth (Bearer Token)

Mobile routes use `Authorization: Bearer {session_token}`.

1. Run **Mobile / Auth / Bootstrap Anonymous Auth**
2. The test script automatically sets `authToken` and `userId` in the environment
3. All subsequent mobile requests use `{{authToken}}` in their Authorization header

To get a fresh token, run Bootstrap again. To invalidate the current token, run **Logout**.

### Admin Auth (API Key)

Admin routes use `X-Admin-Key: {ADMIN_API_KEY}`.

Set the `adminApiKey` environment variable to match the `ADMIN_API_KEY` value configured in your Worker secrets (`.dev.vars` for local dev).

All requests in the **Admin** folder include this header automatically.

**Admin routes are NOT mobile-safe.** Do not expose the admin API key to client applications.

### Webhook Auth

The RevenueCat webhook endpoint uses `Authorization: Bearer {REVENUECAT_WEBHOOK_SECRET}`.

Set the `revenuecatWebhookSecret` environment variable to match the `REVENUECAT_WEBHOOK_SECRET` in your Worker secrets. The webhook request in the **Webhooks** folder includes this header.

### Internal Routes (No Auth)

Internal routes (`/api/internal/*`) have no built-in auth middleware. They are intended to be secured at the network level (e.g., Cloudflare Access) and are for service-to-service use only. **Not mobile-safe.**

## Recommended End-to-End Test Order

### 1. Health check
Run **Health / Health Check** and **Health / Version** to verify the Worker is running.

### 2. Bootstrap auth
Run **Mobile / Auth / Bootstrap Anonymous Auth**. This auto-sets `authToken` and `userId`.

### 3. Browse filters
Run **Mobile / Filters / List Active Filters**. If no filters exist, use **Admin / Filters / Create Filter** first (requires `adminApiKey`).

### 4. Check billing state
Run **Mobile / Billing / Get Billing State (Me)** to see initial coin balance and subscription status.

### 5. Request upload
Run **Mobile / Uploads / Request Upload URL**. This auto-sets `assetId`, `uploadUrl`, and `storageKey`.

### 6. Upload file (manual step)
Run **Mobile / Uploads / Upload File to Signed R2 URL**:
- Go to the **Body** tab
- Select **Binary** > choose a local image/video file
- Send the PUT request to the presigned R2 URL

**Note:** The signed URL expires in ~600 seconds. Rerun step 5 if it expires.

### 7. Confirm upload
Run **Mobile / Uploads / Confirm Upload**. The asset status changes to `uploaded`.

### 8. Create generation
Run **Mobile / Generations / Create Generation**. This auto-sets `generationId`.

### 9. Check generation status
Run **Mobile / Generations / Get Generation Detail**. Poll this to watch status change.

### 10. Trigger sync (if needed)
Run **Internal / Sync Generation by ID** or **Internal / Sync Pending Generations** to manually trigger provider status sync.

### 11. Inspect output
After generation completes, run **Mobile / Generations / Get Generation Detail** again to get `outputAssetId`, then run **Mobile / Assets / Get Output Asset** to see the signed read URL.

### 12. Inspect billing
Run **Mobile / Billing / Get Coin Balance** to verify coins were deducted (if the filter has a cost).

### 13. Admin inspection (optional)
Use the **Admin** folder for cross-user inspection, job cancellation, filter management, and billing operations.

## Upload Flow Detail

Uploads use direct-to-R2 presigned URLs:

```
Client                      Worker                    R2
  |                           |                        |
  |-- POST /uploads/request ->|                        |
  |<- { assetId, uploadUrl } -|                        |
  |                           |                        |
  |-- PUT uploadUrl (binary) ----------------------->  |
  |<- 200 OK ---------------------------------------- |
  |                           |                        |
  |-- POST /uploads/confirm ->|                        |
  |<- { status: "uploaded" } -|                        |
```

The `Upload File to Signed R2 URL` request in Postman is a PUT to the R2 presigned URL, not to the Worker. You must manually select a file in Postman's Body > Binary picker.

## Billing Flow Detail

### Mobile billing reads
- `GET /api/mobile/billing/me` — combined coins + subscription
- `GET /api/mobile/billing/coins` — coin balance only
- `GET /api/mobile/billing/entitlements` — subscription state only
- `GET /api/mobile/billing/products` — available products
- `POST /api/mobile/billing/customer` — register RevenueCat customer mapping

### Admin billing management
- `GET /api/admin/billing/products` — list all products (admin view)
- `POST /api/admin/billing/products` — create product
- `PATCH /api/admin/billing/products/:id` — update product
- `GET /api/admin/billing/users/:id` — full user billing detail
- `POST /api/admin/billing/users/:id/coin-grant` — manually grant coins
- `POST /api/admin/billing/users/:id/coin-debit` — manually debit coins
- `GET /api/admin/billing/events` — recent billing events

### Webhook testing
Use the **Webhooks / RevenueCat Webhook** request to simulate a purchase event. The example body simulates a `NON_RENEWING_PURCHASE` for a coin pack. Adjust the `event.type` and fields for different scenarios:

- `INITIAL_PURCHASE` — new subscription
- `RENEWAL` — subscription renewal
- `CANCELLATION` — subscription cancelled
- `EXPIRATION` — subscription expired
- `NON_RENEWING_PURCHASE` — one-time coin pack purchase

## Route Access Summary

| Folder | Auth | Audience |
|--------|------|----------|
| Health | None | Public |
| Mobile / Auth | None (bootstrap), Bearer token (me, logout) | Mobile clients |
| Mobile / Filters | None | Mobile clients |
| Mobile / Uploads | Bearer token | Mobile clients |
| Mobile / Assets | Bearer token | Mobile clients |
| Mobile / Generations | Bearer token | Mobile clients |
| Mobile / Billing | Bearer token | Mobile clients |
| Mobile / Devices | None (placeholder, returns 501) | Mobile clients |
| Admin/* | `X-Admin-Key` header | Admin dashboards / internal tools |
| Internal | None (network-level) | Service-to-service |
| Webhooks | `Authorization: Bearer {secret}` | RevenueCat servers |

## Known Limitations

- Direct R2 upload uses a presigned URL that expires after ~600 seconds. Rerun `Request Upload URL` if it expires.
- The signed R2 upload step cannot choose a local file automatically; select the file manually in Postman.
- `Admin / Filters / Create Filter` creates a filter record, but successful generation depends on a valid backend Atlas API key and a valid `atlasModelId`.
- `Mobile / Devices` routes return placeholder 501 responses.
- `Admin / Assets / Delete Asset` deletes only the D1 row; it does not remove the R2 object.
