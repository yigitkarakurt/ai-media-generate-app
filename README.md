# AI Media Generate App — Backend API

Backend API for an AI media generation platform, serving both a React Native mobile app and a web admin panel.

Built on **Cloudflare Workers** with **D1** (database) and **R2** (media storage).

## Architecture

```
src/
├── index.ts                         # Entry point, route mounting, error handler
├── bindings.ts                      # Cloudflare resource bindings (AppEnv type)
├── types.ts                         # Re-exports
│
├── shared/
│   ├── api-response.ts              # Consistent response format (success, error, paginated)
│   ├── errors.ts                    # AppError class with static factories
│   ├── media.ts                     # Media validation (mime types, file size, storage keys)
│   └── validation.ts               # Shared Zod schemas (pagination, UUID params)
│
├── lib/
│   └── r2.ts                       # R2 presigned URL generation (upload + read)
│
├── middleware/
│   ├── auth.ts                      # Production auth (Bearer token + dev fallback)
│   ├── admin-auth.ts                # Admin API key auth (X-Admin-Key header)
│   └── dev-auth.ts                  # Legacy dev auth (kept for reference)
│
├── core/
│   ├── auth/
│   │   ├── bootstrap.ts             # Anonymous auth bootstrap orchestration
│   │   ├── devices.ts               # Device record recovery + registration
│   │   └── sessions.ts              # Opaque session token management
│   ├── assets/
│   │   └── client.ts               # Client-safe asset type + toClientAsset() helper
│   ├── billing/
│   │   ├── types.ts                 # RevenueCat webhook types, billing domain types
│   │   ├── queries.ts               # Billing DB helpers (coins, entitlements, products)
│   │   └── process-event.ts         # RevenueCat webhook event processor
│   ├── db/
│   │   └── schema.ts               # TypeScript types matching D1 tables
│   ├── tracking/
│   │   └── tracker.ts              # extractRequestContext() + fire-and-forget trackEvent()
│   └── generation/
│       ├── types.ts                 # Provider-agnostic generation interfaces
│       ├── dispatch.ts              # Provider router (routes to registered adapters)
│       ├── sync.ts                  # Job sync logic (single + batch) + output handling
│       ├── scheduled.ts             # Cron trigger handler for automatic batch sync
│       └── providers/
│           ├── index.ts             # Provider registry (atlas, openrouter)
│           ├── atlas.ts             # Atlas Cloud adapter (submit + status polling)
│           └── openrouter/
│               ├── index.ts         # OpenRouter provider (synchronous, inline-complete)
│               ├── types.ts         # OpenRouter API types + ModelAdapter interface
│               └── adapters/
│                   └── seedream-4-5.ts  # Seedream 4.5 request builder (text_to_image + image_to_image)
│
└── modules/
    ├── health/
    │   └── routes.ts                # GET /api/health, GET /api/version
    ├── mobile/
    │   ├── auth.ts                  # POST /bootstrap, GET /me, POST /logout
    │   ├── home.ts                  # GET /api/mobile/home (featured + categories)
    │   ├── filters.ts               # GET /api/mobile/filters, GET /:slug (with previews)
    │   ├── categories.ts            # GET /api/mobile/categories, GET /:slug/filters
    │   ├── assets.ts                # GET /api/mobile/assets, GET /api/mobile/assets/:id
    │   ├── generations.ts           # GET,POST /api/mobile/generations
    │   ├── uploads.ts               # POST /api/mobile/uploads/request, /confirm
    │   ├── billing.ts               # Billing state, coins, entitlements
    │   └── devices.ts               # POST,DELETE /api/mobile/devices/push-token
    ├── admin/
    │   ├── billing.ts               # Product CRUD, coin grant/debit, events
    │   ├── dashboard.ts             # GET /api/admin/dashboard
    │   ├── users.ts                 # GET /api/admin/users
    │   ├── jobs.ts                  # GET /api/admin/jobs, POST cancel
    │   ├── assets.ts                # GET,DELETE /api/admin/assets
    │   ├── filters.ts               # Full CRUD + previews + category assignments
    │   ├── tags.ts                  # Tag CRUD /api/admin/tags
    │   ├── categories.ts            # Category CRUD + filter assignments
    │   ├── settings.ts             # GET,PUT,DELETE /api/admin/settings
    │   └── tracking.ts             # GET /api/admin/tracking/events (paginated)
    └── internal/
        └── generations.ts           # POST sync-pending, POST :id/sync
```

## Upload Flow

The upload system uses **direct-to-R2 uploads** — the Worker never proxies file bytes.

```
Mobile App                       Backend (Worker)                  Cloudflare R2
    │                                   │                               │
    ├─ POST /uploads/request ──────────>│                               │
    │  { filename, mimeType,            │                               │
    │    fileSizeBytes }                │── create pending asset (D1)    │
    │                                   │── generate presigned PUT URL   │
    │<── { assetId, uploadUrl,  ────────│                               │
    │      storageKey, expiresIn }      │                               │
    │                                   │                               │
    ├─ PUT uploadUrl (file bytes) ─────────────────────────────────────>│
    │<── 200 OK ───────────────────────────────────────────────────────│
    │                                   │                               │
    ├─ POST /uploads/confirm ──────────>│                               │
    │  { assetId, width?, height?,      │── verify object in R2 (HEAD)──>│
    │    durationSeconds? }             │<── object metadata ───────────│
    │                                   │── update asset → 'uploaded'   │
    │<── { asset } ─────────────────────│                               │
```

### Key design decisions:
- **Presigned URLs via aws4fetch** — R2 Worker bindings can't generate presigned URLs; the S3-compatible API is required
- **Backend never proxies bytes** — client uploads directly to R2, keeping Worker CPU/memory usage near zero
- **Two-phase upload** — request creates a pending record, confirm transitions to uploaded after R2 verification
- **R2 HEAD check on confirm** — prevents fake confirmations; the file must actually exist in R2

## Asset Lifecycle

```
pending → uploaded → processing → ready
                                → failed
```

| Status | Meaning |
|--------|---------|
| `pending` | Asset record created, presigned URL issued, file not yet uploaded |
| `uploaded` | File confirmed in R2, ready for generation |
| `processing` | Being used in an active generation job |
| `ready` | Generation output available |
| `failed` | Processing failed |

Assets have a `kind` field: `input` (user uploads) or `output` (generation results).

## Client Asset Access

Mobile clients access their assets via `GET /api/mobile/assets` and `GET /api/mobile/assets/:id`.
Both endpoints return client-safe responses with short-lived signed read URLs.

### Asset Response Shape

```json
{
  "id": "uuid",
  "kind": "output",
  "media_type": "image",
  "status": "ready",
  "original_filename": "output_abc123.png",
  "mime_type": "image/png",
  "size_bytes": 524288,
  "width": null,
  "height": null,
  "duration_seconds": null,
  "created_at": "...",
  "updated_at": "...",
  "read_url": "https://...r2.cloudflarestorage.com/...?X-Amz-...",
  "read_url_expires_at": "2026-04-13T15:00:00.000Z"
}
```

- `read_url` is a signed R2 GET URL (1 hour expiry), generated on demand
- `read_url` is `null` for assets not yet in R2 (status `pending` or `failed`)
- Internal fields (`storage_key`, `user_id`, `metadata`) are never exposed
- Field names are client-friendly: `type` -> `media_type`, `file_size_bytes` -> `size_bytes`

### Asset List Filtering

```
GET /api/mobile/assets?kind=output&media_type=image&status=ready&page=1&pageSize=20
```

All filters are optional and combine with AND logic.

### Generation Detail with Output Asset

`GET /api/mobile/generations/:id` for completed jobs includes an inline `output_asset` summary
with a signed read URL, so the client can display the output without a second request.

## Generation Job Flow

When a mobile client submits a generation request, the backend validates all preconditions,
creates a job, routes it through the provider layer, and calls the real provider API.

```
Mobile App                       Backend (Worker)                  Atlas Cloud
    │                                   │                               │
    ├─ POST /generations ──────────────>│                               │
    │  { filter_id, input_asset_id }    │                               │
    │                                   │── validate asset ownership    │
    │                                   │── verify asset status=uploaded│
    │                                   │── verify asset kind=input     │
    │                                   │── verify filter exists+active │
    │                                   │── verify media compatibility  │
    │                                   │── create job (status: queued) │
    │                                   │── generate signed R2 read URL │
    │                                   │── build prompt from filter    │
    │                                   │── route to provider adapter ─>│
    │                                   │<── { data.id }  ──────────────│
    │                                   │── update job → processing     │
    │<── { job } ───────────────────────│                               │
    │                                   │                               │
    ├─ GET /generations/:id ───────────>│                               │
    │<── { job (client-safe fields) } ──│                               │
    │                                   │                               │
    ├─ GET /generations?status=... ────>│                               │
    │<── { jobs[], pagination } ────────│                               │
```

### Generation Job Lifecycle

```
queued → processing → completed
                    → failed
```

| Status | Meaning |
|--------|---------|
| `queued` | Job created, not yet submitted to provider |
| `processing` | Provider accepted the job (Atlas returns `data.id`) |
| `completed` | Generation finished, output asset stored in R2 and linked via `output_asset_id` |
| `failed` | Dispatch or generation failed, error_code and error_message populated |

Additionally, admin can set status to `cancelled` for jobs in `queued` or `processing` state.

### Provider Router

The dispatch layer is provider-agnostic. Each filter has a `provider_name` field that determines
which adapter handles the generation. Adapters are registered in `src/core/generation/providers/index.ts`.

```
Filter (provider_name: "atlas")
    → dispatch.ts (router)
        → getProvider("atlas")
            → atlasProvider.submit(ctx)
                → POST https://api.atlascloud.ai/...

Filter (provider_name: "openrouter")
    → dispatch.ts (router)
        → getProvider("openrouter")
            → openrouterProvider.submit(ctx)
                → resolves model adapter (Seedream45Adapter for bytedance-seed/seedream-4.5)
                → adapter.buildRequest(ctx)  ← model-specific request shaping
                → POST https://openrouter.ai/api/v1/chat/completions
                → parse data URL → write R2 → insert output asset → return completed
```

Adding a new provider: create `providers/<name>/index.ts`, implement `GenerationProvider`,
register in `providers/index.ts`.

Adding a new OpenRouter model: create `providers/openrouter/adapters/<model>.ts`, implement
`ModelAdapter`, add to `adapterRegistry` in `providers/openrouter/index.ts`.

## Filter Catalog

Filters are the backend-controlled product catalog for mobile generation. The mobile client starts generation with a `filter_id`; it never supplies prompts, provider names, model keys, or operation types.

### Catalog Data Model

The catalog uses four related entities:

```
filters ──┬── tags              (one primary tag per filter via tag_id)
           ├── filter_previews   (multiple preview images per filter)
           └── filter_categories ─── categories  (many-to-many)
```

- **Filters** — generation recipes with provider routing, prompts, and billing
- **Tags** — lightweight UI badges (Popular, New, Editor's Pick, etc.)
- **Categories** — reusable content sections for the home screen and catalog browsing
- **Filter Previews** — multiple preview assets per filter (primary + gallery)

### Mobile Catalog Responses

Mobile filter responses are client-safe — backend-only fields are never exposed:

```json
{
  "id": "filter-id",
  "slug": "cinematic-portrait",
  "name": "Cinematic Portrait",
  "description": "Studio-grade portrait lighting with a cinematic finish.",
  "coin_cost": 8,
  "preview_image_url": "https://...",
  "primary_preview": {
    "id": "preview-id",
    "preview_url": "https://...",
    "media_type": "image"
  },
  "tag": { "id": "tag-id", "slug": "popular", "name": "Popular" },
  "is_featured": true,
  "is_active": true
}
```

Filter detail (`GET /api/mobile/filters/:slug`) additionally includes:
- `previews` — full preview gallery array
- `categories` — array of categories this filter belongs to

Backend-only fields remain admin/internal only:

| Field | Purpose |
|-------|---------|
| `provider_name` | Provider adapter route, for example `atlas` or `openrouter` |
| `model_key` | Provider model identifier, for example `bytedance-seed/seedream-4.5` |
| `operation_type` | `text_to_image` or `image_to_image` |
| `prompt_template` | Backend-owned generation prompt |
| `default_params_json` | Provider-specific defaults |

Each filter has a required `coin_cost` integer. A value of `0` is free. Generation billing debits the filter's cost before dispatch and refunds it if dispatch fails.

### Featured Filters

Filters can be marked `is_featured = true` with a `featured_sort_order` for the home screen hero section. The mobile home endpoint returns featured filters separately from category sections.

### Categories

Categories are reusable content sections managed via `/api/admin/categories`. A filter can belong to multiple categories through the `filter_categories` join table. Categories have:

- `show_on_home` — whether the category appears as a section on the mobile home screen
- `home_sort_order` — ordering within the home screen
- `sort_order` — ordering in the full category listing

### Multiple Previews

Each filter can have multiple preview images via the `filter_previews` table. One preview per filter can be marked `is_primary` (enforced by a partial unique index). Mobile list views show the primary preview; detail views include the full gallery.

Legacy `preview_image_url` on the filter row is preserved as a fallback when no `filter_previews` rows exist.

### Tags

Tags live in a dedicated `tags` table and are managed through `/api/admin/tags`. A filter may reference at most one tag through `filters.tag_id` (the primary tag/badge). There is intentionally no join table and no multi-tag support.

Admins create tags separately, then choose an existing `tag_id` when creating or updating a filter. Filter writes reject unknown `tag_id` values with `INVALID_TAG_ID`. Mobile clients receive only tag display data.

Seeded tags:

| Slug | Name | Type |
|------|------|------|
| `portrait` | Portrait | Style |
| `cinematic` | Cinematic | Style |
| `artistic` | Artistic | Style |
| `product` | Product | Style |
| `popular` | Popular | Badge |
| `new` | New | Badge |
| `editors-pick` | Editor's Pick | Badge |
| `trending` | Trending | Badge |
| `premium` | Premium | Badge |

Seeded categories:

| Slug | Name | Show on Home |
|------|------|:---:|
| `trending` | Trending | Yes |
| `portraits` | Portraits | Yes |
| `product-photography` | Product Photography | Yes |
| `artistic-styles` | Artistic Styles | Yes |
| `editors-picks` | Editor's Picks | No |

Seeded filters:

| Slug | Provider | Model Key | Operation | Cost | Tag | Featured |
|------|----------|-----------|-----------|------|-----|:---:|
| `cinematic-portrait` | `atlas` | `alibaba/wan-2.7/image-edit` | `image_to_image` | 8 | Popular | Yes |
| `product-hero-shot` | `atlas` | `alibaba/wan-2.7/image-edit` | `image_to_image` | 10 | New | Yes |
| `dream-scene` | `openrouter` | `bytedance-seed/seedream-4.5` | `text_to_image` | 6 | Trending | No |
| `editorial-remix` | `openrouter` | `bytedance-seed/seedream-4.5` | `image_to_image` | 7 | Editor's Pick | No |

### Home API

`GET /api/mobile/home` returns the data for the mobile home screen:

```json
{
  "success": true,
  "data": {
    "featured": [
      { "slug": "cinematic-portrait", "coin_cost": 8, "tag": {...}, "primary_preview": {...} }
    ],
    "categories": [
      {
        "slug": "trending",
        "name": "Trending",
        "filters": [
          { "slug": "cinematic-portrait", "coin_cost": 8, "tag": {...}, "primary_preview": {...} }
        ]
      }
    ]
  }
}
```

- Featured section: `is_featured = 1` filters, ordered by `featured_sort_order`
- Category sections: categories with `show_on_home = 1`, each with up to 10 filters
- All items include primary preview and tag badge
- No backend-only fields (prompt, provider, etc.) are exposed

### Deferred Catalog Work

- Many-to-many tags (multiple tags per filter)
- Video preview support (filter_previews.media_type currently image-only)
- Dynamic preview generation
- Client-provided prompts
- Client-side provider selection
- Quick action backend config (AI Görüntü / Görsel→Video / Metin→Video remain mobile-static)

## OpenRouter Provider — Seedream 4.5

### Overview

OpenRouter is the second generation provider. Unlike Atlas (async + polling), OpenRouter
image generation with `bytedance-seed/seedream-4.5` is **synchronous**: the API returns
the generated image in the same HTTP response as a base64 data URL.

The backend decodes this data URL, writes the raw bytes to R2, creates an output asset row
in D1, and returns `status = "completed"` in the same request lifecycle. No polling or
scheduled sync is needed for OpenRouter jobs.

The mobile client is completely unaware of OpenRouter — it only ever sees normalized job
statuses and output asset IDs, exactly as with Atlas.

### Supported operations

| Operation | Behaviour |
|-----------|-----------|
| `text_to_image` | Sends text prompt only. `modalities: ["image"]`. |
| `image_to_image` | Sends text prompt + signed R2 read URL for the input image. The provider fetches the input directly from R2. |

The operation is controlled by the filter's `operation_type` column. Legacy `config.operation_type`
is still mirrored for compatibility. The mobile client never sets either value.

### Filter configuration

To target OpenRouter with Seedream 4.5, set the following on a filter (via admin API):

| Field | Value |
|-------|-------|
| `provider_name` | `openrouter` |
| `model_key` | `bytedance-seed/seedream-4.5` |
| `operation_type` | `text_to_image` or `image_to_image` |
| `prompt_template` | Backend-controlled prompt text |
| `input_media_types` | `image` (video not supported for this adapter) |
| `coin_cost` | Integer generation cost |

Example admin API call:
```bash
curl -X POST http://localhost:8787/api/admin/filters \
  -H "X-Admin-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Dreamlike Style",
    "slug": "dreamlike-style",
    "description": "AI-powered dreamlike artistic transformation",
    "provider_name": "openrouter",
    "model_key": "bytedance-seed/seedream-4.5",
    "operation_type": "image_to_image",
    "prompt_template": "Transform this photo into a dreamlike artistic painting",
    "input_media_types": "image",
    "coin_cost": 5,
    "preview_image_url": "https://example.com/preview.jpg"
  }'
```

### Data URL output handling

OpenRouter returns generated images as data URLs:
```
data:image/jpeg;base64,/9j/4AAQ...
```

The backend:
1. Validates the `data:` prefix and `;base64,` encoding marker
2. Extracts the mime type (`image/jpeg`, `image/png`, etc.)
3. Decodes the base64 payload with `atob()`
4. Writes raw bytes directly to R2 (no network fetch needed)
5. Creates an output asset row in D1 (`kind='output'`, `status='ready'`)
6. Returns `initialStatus="completed"` immediately

### ModelAdapter extensibility

Every OpenRouter model has its own adapter file:

```
providers/openrouter/adapters/
    seedream-4-5.ts      ← bytedance-seed/seedream-4.5 (text_to_image + image_to_image)
    <future-model>.ts    ← next model, different request/response shape
```

The `OpenRouterProvider` handles all shared concerns (auth, HTTP, data URL parsing, R2 write,
D1 insert). Each `ModelAdapter` only implements `buildRequest(ctx)`. This prevents model-specific
quirks from leaking into the route handler or cross-contaminating other models.

### Current limitation: single primary image for image_to_image

`Seedream45Adapter` currently uses **only the first URL** from `inputImageUrls[0]`.
The `DispatchRequest.inputImageUrls` field is already an array, so the architecture supports
multi-image input, but full reference-image behavior is deferred.

### Deferred for future OpenRouter work

- Additional OpenRouter models (one new adapter file each)
- Multi-image reference input for Seedream 4.5
- `usage.cost` persistence from the OpenRouter response
- Video generation endpoints (not in scope for this provider)



### Prompt Rules

- The mobile client **never** sends a prompt
- Prompt text comes exclusively from the filter's `prompt_template` field
- The backend reads `prompt_template` and passes it directly to the provider
- Filters are configured via the admin API (`POST/PATCH /api/admin/filters`)

### Signed R2 Read URLs

Input assets are stored in R2. To give providers access without proxying file bytes through the Worker:

1. Backend generates a short-lived signed GET URL (1 hour expiry) for the R2 object
2. The signed URL is sent to the provider in the `images` array
3. The provider fetches the image directly from R2

This keeps the Worker lightweight and avoids memory/CPU overhead of proxying large files.

## Generation Job Sync Flow

After a job is submitted to Atlas, the backend polls for completion and processes the output.
Sync happens automatically via a cron trigger (every 2 minutes) and can also be triggered manually.

```
Cron / Manual                    Backend (Worker)                  Atlas Cloud
    │                                   │                               │
    │  [automatic: every 2 min]         │                               │
    ├─ scheduled event ────────────────>│                               │
    │                                   │── query non-terminal jobs     │
    │                                   │── for each (batch of 10):     │
    │                                   │   ├── GET /prediction/:id ───>│
    │                                   │   │<── { status, outputs[] } ─│
    │                                   │   │                           │
    │                                   │   │  [if completed]           │
    │                                   │   ├── fetch output URL        │
    │                                   │   ├── store in R2             │
    │                                   │   ├── create output asset     │
    │                                   │   └── update job → completed  │
    │                                   │                               │
    │  [manual: single job]             │                               │
    ├─ POST /internal/generations/      │                               │
    │       :id/sync ─────────────────>│── same sync logic ────────────>│
    │                                   │                               │
    │  [manual: batch]                  │                               │
    ├─ POST /internal/generations/      │                               │
    │       sync-pending ─────────────>│── same sync logic ────────────>│
```

### Automatic Background Sync

A Cloudflare cron trigger runs every 2 minutes, calling `syncPendingJobs()`:

1. Selects up to 10 jobs in `queued` or `processing` status with provider info
2. Orders by `updated_at ASC` (least recently synced first — natural priority queue)
3. Calls `syncGenerationJob()` for each, catching individual errors
4. Logs summary: synced, completed, failed, unchanged counts

This avoids overwhelming the provider API (sequential, bounded batch) and ensures all jobs
eventually get synced even under load.

### Atlas Status Mapping

| Atlas Raw Status | Internal Status |
|-----------------|-----------------|
| `processing` | `processing` |
| `completed` | `completed` |
| `succeeded` | `completed` |
| `failed` | `failed` |
| (unknown) | `processing` (safe default) |

### Output Asset Creation

When Atlas reports completion:
1. Output URL is read from `data.outputs[0]`
2. The output file is fetched from the provider URL
3. The file is stored in R2 under `output/{userId}/{assetId}/{filename}`
4. An asset record is created in D1 with `kind='output'`, `status='ready'`
5. The generation job is linked via `output_asset_id` and marked `completed`

Output files are persisted to R2 — the system never depends on third-party URLs long-term.

### Sync Idempotency

The sync function is safe to call multiple times:
- Terminal jobs (completed/failed/cancelled) return `{ changed: false }`
- If the output asset was stored but the job update failed, the next sync detects `output_asset_id` and skips re-fetching
- R2 puts to the same key are overwrites (safe on retry)

### Validation Rules (POST /generations)

| Rule | Error Code |
|------|------------|
| Input asset must exist and belong to user | `NOT_FOUND` |
| Input asset must be `uploaded` status | `ASSET_NOT_READY` |
| Input asset must be `input` kind | `INVALID_ASSET_KIND` |
| Filter must exist | `NOT_FOUND` |
| Filter must be active | `FILTER_INACTIVE` |
| Filter must accept the asset's media type | `MEDIA_TYPE_INCOMPATIBLE` |
| User must have enough coins for filter's `coin_cost` | `INSUFFICIENT_COINS` |

### Client-Facing Job Fields

The mobile client receives only normalized fields — no provider internals:

```json
{
  "id": "uuid",
  "filter_id": "uuid",
  "input_asset_id": "uuid",
  "output_asset_id": null,
  "status": "queued",
  "error_code": null,
  "error_message": null,
  "created_at": "...",
  "queued_at": "...",
  "started_at": null,
  "completed_at": null,
  "failed_at": null
}
```

Provider-specific fields (`provider_name`, `provider_job_id`, `provider_status`) are
stored in D1 but never exposed to the mobile client.

## Authentication

### Model: anonymous-first, no login screen

Users start using the app immediately. On first launch, the mobile client
calls **POST /api/mobile/auth/bootstrap** with a device payload. The backend
either recovers an existing anonymous user or creates a new one, then returns
an opaque session token.

All subsequent requests use `Authorization: Bearer <token>`.

### Token / session design

**Opaque tokens backed by D1** (not JWTs).

- A 256-bit random token prefixed with `amb_` is generated on bootstrap.
- Only a SHA-256 hash of the token is stored in the `auth_sessions` table.
- The raw token is returned to the client once and never stored on the backend.
- Tokens expire after 90 days by default.
- Revocation is instant — deactivate the session row.

This was chosen over JWTs because:
- Revocation is trivial (no blacklist infrastructure needed).
- No token-refresh complexity for the client.
- D1 lookups are fast (same datacenter as the Worker).
- Simpler to implement correctly.

### Device recovery (best-effort)

On bootstrap, the backend attempts to match the client's `device_identifier`
and `platform` against known device records. If a match is found and the
linked user is still active, that user is recovered instead of creating a new
account.

**Limitations — be honest about these:**

- `device_identifier` (Android ID, identifierForVendor, etc.) is **not
  permanent**. It can change after factory reset, OS reinstall, or on certain
  device models.
- Recovery is **best-effort only**. There is no guarantee that the same user
  will be recovered after a device wipe.
- `installation_id` (app-local) changes on every reinstall by definition —
  it is recorded for observability but not used as a primary recovery key.
- If the device identifier is absent or null, recovery is skipped entirely.
- The system prefers creating a new user over making a wrong match.

The architecture supports future integrity signals (Play Integrity, App
Attest) via placeholder columns on `user_devices`, but none are implemented
yet.

### No-login onboarding flow

```
Mobile App                              Backend
─────────                               ───────
1. First launch
2. Collect device info
   (platform, device_id, install_id,
    app_version, model, os_version)
3. POST /auth/bootstrap ──────────────► 4. Look for matching device
                                        5. If found → recover user
                                           If not  → create anon user
                                        6. Register/update device record
                                        7. Issue session token
                              ◄──────── 8. Return { access_token, user, ... }
9. Store access_token locally
10. Use Bearer token for all requests
```

### Auth endpoints

| Method | Path                           | Auth     | Description                     |
|--------|--------------------------------|----------|---------------------------------|
| POST   | /api/mobile/auth/bootstrap     | None     | Create or recover anonymous user |
| GET    | /api/mobile/auth/me            | Required | Current user info               |
| POST   | /api/mobile/auth/logout        | Required | Revoke current session          |

### Dev auth (non-production only)

In **development** and **test** environments only, the `X-Dev-User-Id` header
is accepted as a fallback so existing Postman collections and dev tools
continue to work.

**Fail-closed:** If `ENVIRONMENT` is missing, empty, or any value other than
`development` or `test`, the dev auth fallback is **disabled**. This prevents
accidental auth bypass in production even if `ENVIRONMENT` is misconfigured.

Attempts to use `X-Dev-User-Id` in non-dev environments are logged as security
events.

## Billing (RevenueCat)

### RevenueCat webhook event handling

The backend processes RevenueCat server-to-server webhooks at
`POST /api/webhooks/revenuecat`, authenticated with a shared Bearer secret.

| Event Type | Behavior |
|------------|----------|
| `INITIAL_PURCHASE` | Activate entitlement (subscription) or grant coins (coin_pack) |
| `RENEWAL` | Refresh entitlement, update `last_renewed_at`, clear billing issues |
| `NON_RENEWING_PURCHASE` | Grant coins for coin_pack products |
| `CANCELLATION` | **Subscription:** mark `unsubscribed_at`, keep active until expiration. **Coin pack:** create negative refund ledger entry. |
| `UNCANCELLATION` | Clear `unsubscribed_at` and `billing_issue_at` — user re-subscribed |
| `EXPIRATION` | Mark entitlement inactive (`is_active = 0`) |
| `BILLING_ISSUE` | Record `billing_issue_at` timestamp — do NOT revoke access (grace period) |
| `PRODUCT_CHANGE` | Update `rc_product_id` and `entitlement_id` on user entitlement |

### Subscription lifecycle

```
INITIAL_PURCHASE → active (is_active=1, unsubscribed_at=NULL)
    │
    ├─ RENEWAL → active, last_renewed_at refreshed
    ├─ BILLING_ISSUE → active, billing_issue_at set (grace period)
    ├─ CANCELLATION → active, unsubscribed_at set (still valid until expiry)
    │   └─ UNCANCELLATION → active, unsubscribed_at cleared
    ├─ PRODUCT_CHANGE → active, product/entitlement updated
    └─ EXPIRATION → inactive (is_active=0)
```

### Coin pack refunds

When a `CANCELLATION` event targets a coin_pack product, a **negative**
compensating entry is written to `coin_ledger` with reason `refund`.
The append-only ledger is never mutated — only new entries are added.

### Idempotency

- **Event-level:** `billing_events.rc_event_id` has a UNIQUE index. Duplicate
  webhook deliveries return `skipped_duplicate` immediately.
- **Coin-grant-level:** `hasCoinEntryForEvent()` prevents double credits even
  if the event-level check were somehow bypassed.
- **Atomic writes:** `db.batch()` writes the event record and its side effects
  (entitlement upsert, coin entry) in a single D1 batch. If the batch fails,
  neither the event nor the side effect is persisted, so RevenueCat's retry
  will process cleanly.

### Generation coin debit

Each filter has a `coin_cost` column (default 0 = free). When a user submits
a generation:

1. Backend reads `filter.coin_cost`
2. If cost > 0, checks `getCoinBalance(userId) >= cost`
3. If insufficient, rejects with `INSUFFICIENT_COINS`
4. Creates a negative `generation_debit` entry in `coin_ledger`
5. Dispatches to the provider
6. If dispatch fails, creates a positive `refund` compensating entry

The client never provides the cost — it is always backend-controlled.

### Admin billing management

All admin routes require `X-Admin-Key` header (see Admin Auth below).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/billing/products` | List all products (including inactive) |
| POST | `/api/admin/billing/products` | Create a product |
| PATCH | `/api/admin/billing/products/:id` | Update a product |
| GET | `/api/admin/billing/users/:id` | Full billing detail for a user |
| POST | `/api/admin/billing/users/:id/coin-grant` | Grant coins manually |
| POST | `/api/admin/billing/users/:id/coin-debit` | Debit coins manually |
| GET | `/api/admin/billing/events` | Paginated webhook event log |

Products must be seeded before billing works. Example:
```bash
curl -X POST http://localhost:8787/api/admin/billing/products \
  -H "X-Admin-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"rc_product_id":"com.app.coins_100","type":"coin_pack","name":"100 Coins","coin_amount":100}'
```

### Admin auth

All `/api/admin/*` routes are protected by the `requireAdmin` middleware.
It validates the `X-Admin-Key` header against the `ADMIN_API_KEY` secret
using timing-safe comparison.

**Fail-closed:** If `ADMIN_API_KEY` is not configured and `ENVIRONMENT` is
not explicitly `development` or `test`, admin routes return 500. The dev
fallback (open admin access without a key) is only active when `ENVIRONMENT`
is explicitly set to `development` or `test`.

```bash
wrangler secret put ADMIN_API_KEY
```

### Internal route auth

All `/api/internal/*` routes are protected by the `requireInternal` middleware.
It validates the `X-Internal-Key` header against the `INTERNAL_API_KEY` secret
using timing-safe comparison.

**Always fail-closed:** If `INTERNAL_API_KEY` is not configured, internal routes
reject all requests regardless of environment. There is no dev fallback.

```bash
wrangler secret put INTERNAL_API_KEY
```

## Route Groups

| Group | Base Path | Auth | Description |
|-------|-----------|------|-------------|
| Health | `/api/health`, `/api/version` | None | Service health and version |
| Mobile Auth | `/api/mobile/auth` | Mixed | Bootstrap (none), me/logout (Bearer) |
| Mobile Uploads | `/api/mobile/uploads` | Bearer | Request presigned URLs + confirm uploads |
| Mobile Assets | `/api/mobile/assets` | Bearer | List/view own assets |
| Mobile Home | `/api/mobile/home` | Bearer | Home screen data (featured + categories) |
| Mobile Filters | `/api/mobile/filters` | Bearer | Browse active filters (with previews) |
| Mobile Categories | `/api/mobile/categories` | Bearer | Browse categories and category filters |
| Mobile Generations | `/api/mobile/generations` | Bearer | Submit and track generation jobs |
| Mobile Billing | `/api/mobile/billing` | Bearer | Billing state, coins, entitlements |
| Mobile Devices | `/api/mobile/devices` | Bearer | Register push notification tokens |
| Admin Dashboard | `/api/admin/dashboard` | Admin | Aggregate stats |
| Admin Users | `/api/admin/users` | Admin | User management |
| Admin Jobs | `/api/admin/jobs` | Admin | Job monitoring and cancellation |
| Admin Assets | `/api/admin/assets` | Admin | Asset management |
| Admin Filters | `/api/admin/filters` | Admin | Filter CRUD + previews + category assignments |
| Admin Tags | `/api/admin/tags` | Admin | Filter tag CRUD |
| Admin Categories | `/api/admin/categories` | Admin | Category CRUD + filter assignments |
| Admin Billing | `/api/admin/billing` | Admin | Product CRUD, coin ops, events |
| Admin Settings | `/api/admin/settings` | Admin | Key-value config store |
| Internal Generations | `/api/internal/generations` | Internal | Job sync (single + batch) |

\* Internal routes require the `X-Internal-Key` header with the `INTERNAL_API_KEY` secret.

| Trigger | Schedule | Description |
|---------|----------|-------------|
| Cron | `*/2 * * * *` | Automatic batch sync of pending generation jobs |

## Database Tables

| Table | Description |
|-------|-------------|
| `users` | User accounts with `is_anonymous` and `status` fields |
| `user_devices` | Device records linked to users (recovery signals) |
| `auth_sessions` | Opaque session tokens (SHA-256 hashed) |
| `auth_identities` | Future: linked Apple/Google/email identities |
| `assets` | Uploaded/generated media files with `kind` (input/output), linked to R2 |
| `filters` | AI generation filter catalog |
| `tags` | Reusable tags/badges for filters |
| `categories` | Reusable content sections for catalog browsing |
| `filter_categories` | Many-to-many join: filters ↔ categories |
| `filter_previews` | Multiple preview images per filter |
| `generation_jobs` | Generation job queue with status tracking |
| `device_push_tokens` | Push notification tokens per device |
| `admin_settings` | Key-value configuration store |
| `billing_customers` | RevenueCat customer mapping |
| `billing_products` | Product catalog (subscriptions + coin packs) |
| `user_entitlements` | Active subscription/entitlement state |
| `billing_events` | Webhook event idempotency log |
| `coin_ledger` | Append-only coin transaction log |

## API Response Format

All endpoints return consistent JSON:

```json
// Success
{ "success": true, "data": { ... } }

// Paginated
{ "success": true, "data": [...], "pagination": { "page": 1, "pageSize": 20, "total": 100, "totalPages": 5 } }

// Error
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Resource not found" } }
```

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 Database | Primary database |
| `MEDIA_BUCKET` | R2 Bucket | Media file storage (binding for HEAD/GET) |
| `JWT_SECRET` | Secret | JWT signing key |
| `ENVIRONMENT` | Variable | `development` / `staging` / `production` |
| `R2_BUCKET_NAME` | Variable | R2 bucket name for presigned URLs |
| `R2_ACCESS_KEY_ID` | Secret | R2 S3 API access key |
| `R2_SECRET_ACCESS_KEY` | Secret | R2 S3 API secret key |
| `R2_ACCOUNT_ID` | Secret | Cloudflare account ID for R2 S3 endpoint |
| `ATLASCLOUD_API_KEY` | Secret | Atlas Cloud API key for generation |
| `OPENROUTER_API_KEY` | Secret | OpenRouter API key for image generation |
| `REVENUECAT_WEBHOOK_SECRET` | Secret | RevenueCat webhook Bearer token |
| `ADMIN_API_KEY` | Secret | Admin panel API key (`X-Admin-Key` header) |
| `INTERNAL_API_KEY` | Secret | Internal route API key (`X-Internal-Key` header) |

## Development

```bash
# Install dependencies
npm install

# Run locally (applies migrations + starts dev server)
npm run dev

# Apply migrations to remote D1
wrangler d1 migrations apply DB --remote

# Set R2 secrets for presigned URLs
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID

# Set provider API keys
wrangler secret put ATLASCLOUD_API_KEY
wrangler secret put OPENROUTER_API_KEY

# Set billing/admin/internal secrets
wrangler secret put REVENUECAT_WEBHOOK_SECRET
wrangler secret put ADMIN_API_KEY
wrangler secret put INTERNAL_API_KEY

# Deploy
npm run deploy

# Run tests
npm test

# Regenerate Cloudflare types
npm run cf-typegen
```

## Testing

The backend test suite uses Vitest with Cloudflare's Workers test integration.
Tests run locally in Miniflare with Worker-compatible D1 and R2 bindings, and
exercise the real router where practical.

```bash
# Run the test suite once
npm test

# Equivalent explicit command for CI
npm run test:run

# Watch mode
npm run test:watch

# Validate Worker bundling separately
npm run test:worker-check
```

Current coverage focuses on the first critical backend flows:

- RevenueCat coin-pack webhook idempotency and unknown product handling
- RevenueCat subscription lifecycle normalization
- Generation insufficient-coins rejection
- Generation debit refund when Atlas dispatch fails
- Admin billing route auth protection

The tests use real D1 migrations, explicit per-test database cleanup, and
test-only bindings for provider secrets. Atlas dispatch is stubbed only where a
deterministic provider failure is required; R2 remains a real Miniflare binding.

Next testing pass should cover auth bootstrap/session validation, upload
request and confirm with R2 object checks, successful generation dispatch and
sync completion, asset read URL behavior, mobile billing routes, and broader
admin product CRUD validation.

## Media Validation

| Constraint | Value |
|-----------|-------|
| Max file size | 100 MB |
| Allowed image types | JPEG, PNG, WebP, HEIC, HEIF |
| Allowed video types | MP4, QuickTime (MOV), WebM |
| Upload URL expiry | 10 minutes |

## Next Implementation Steps

1. **Account linking** — Apple/Google/email login, merging anonymous accounts
2. **Push notifications** — Notify users when generation completes/fails
3. **Play Integrity / App Attest** — Device attestation checks (columns ready)
4. **Token refresh** — Optional if 90-day expiry proves insufficient
5. **Additional OpenRouter models** — Add new `adapters/<model>.ts` + registry entry
6. **Multi-image reference input** — Architecture is ready (`inputImageUrls` is already an array)
7. **Asset deletion** — Allow users to delete their own assets (R2 + D1 cleanup)
8. **Scheduled cleanup** — Cron trigger for stale queued jobs and orphaned R2 objects

### Intentionally Deferred (Not in Current Implementation)

- Apple / Google / email login (auth_identities table is prepared)
- Account linking (merging anonymous with social login)
- Play Integrity / App Attest (placeholder columns exist on user_devices)
- Multi-device session management UI
- Token refresh mechanism
- Push notifications on job completion
- Multi-image reference input for Seedream 4.5 (architecture ready, not wired)
- Additional OpenRouter models beyond Seedream 4.5
- `usage.cost` persistence from OpenRouter responses
- Video generation (text-to-video, image-to-video) — not in scope
- User-provided custom prompts (prompts always come from filter config only)
- Public unauthenticated asset URLs
- Advanced financial reporting / full refund reconciliation
- Mobile RevenueCat SDK integration (client-side)
- Webhook signature verification beyond shared Bearer secret
- Quick action backend config (AI Görüntü / Görsel→Video / Metin→Video remain mobile-static)
- Many-to-many tags (multiple tags per filter — currently one primary tag)
- Video preview support in filter_previews (currently image-only)
- Public unauthenticated catalog access

## Security Hardening Progress

### Completed (Pass 1)

- ✅ **Internal routes protected** — `requireInternal` middleware with `INTERNAL_API_KEY` shared secret, timing-safe comparison, always fail-closed
- ✅ **Mobile device routes auth** — `requireAuth` applied, consistent with all other mobile endpoints
- ✅ **Mobile filter routes auth** — `requireAuth` applied, response shape remains client-safe
- ✅ **Auth fallback hardened** — dev auth bypass uses explicit allowlist (`development`, `test`), missing/unknown `ENVIRONMENT` is treated as production
- ✅ **Admin fallback hardened** — same explicit allowlist approach, missing key in non-dev returns 500
- ✅ **Upload confirm response normalized** — now uses `toClientAsset()`, no longer leaks `storage_key` or `user_id`
- ✅ **Coin idempotency guard fixed** — secondary check now queries via `billing_events.rc_event_id` JOIN instead of freshly generated UUID
- ✅ **Security logging** — denied auth attempts (admin, internal) and suspicious dev auth bypass attempts are logged

### Remaining (Pass 2)

- Rate limiting on bootstrap, uploads, and generation endpoints
- Concurrency-safe generation debit (atomic balance check + debit)
- Device attestation (Play Integrity / App Attest)
- Stale pending asset cleanup cron
- Orphan R2 object cleanup on admin delete
- Structured observability (audit log table, request metadata)
- Admin auth upgrade from shared secret to role-based access
- CORS configuration for admin web panel

## Tracking & Event Logging

The backend includes a **lightweight, server-side event tracking system**. It logs useful business events into a `tracking_events` D1 table whenever existing backend flows execute. There is no client-side ingestion endpoint and no separate analytics product — just boring, append-only D1 inserts hooked into real code paths.

### How it works

Two small helpers live in `src/core/tracking/tracker.ts`:

- **`extractRequestContext(req)`** — reads `CF-Connecting-IP` (with `X-Forwarded-For` fallback), `User-Agent`, request path, and method from a Hono request. Safe: never throws.
- **`trackEvent(db, event_name, opts)`** — inserts a row into `tracking_events`. **Fire-and-forget**: any D1 error is caught, logged as `[tracking] insert failed:…`, and swallowed. A tracking failure never breaks a user-facing request.

### Tracked events

| `event_name` | Trigger | Key metadata |
|---|---|---|
| `auth_bootstrap` | `POST /api/mobile/auth/bootstrap` success | `installation_id`, `device_identifier`, `recovered`, `recovery_method` |
| `billing_customer_linked` | `POST /api/mobile/billing/customer` success | `rc_app_user_id` |
| `generation_created` | `POST /api/mobile/generations` dispatch success | `generation_id`, `filter_id`, `provider_name`, `operation_type` |
| `generation_completed` | Scheduled sync marks a job completed | `generation_id`, `output_asset_id`, `provider_name` |
| `coin_pack_purchased` | RevenueCat `NON_RENEWING_PURCHASE` / `INITIAL_PURCHASE` processed | `rc_product_id`, `coin_amount` |
| `subscription_activated` | RevenueCat `INITIAL_PURCHASE` / `RENEWAL` subscription processed | `rc_product_id`, `entitlement_id`, `event_type` |

Billing tracking fires **after** `db.batch()` succeeds, so it only records events where the actual side effect (coin grant / entitlement upsert) was committed.

### Table schema (`tracking_events`)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `user_id` | TEXT \| NULL | NULL for unauthenticated events |
| `event_name` | TEXT | Event identifier (see table above) |
| `ip_address` | TEXT \| NULL | From `CF-Connecting-IP`; NULL for scheduled events |
| `user_agent` | TEXT \| NULL | From `User-Agent` header; NULL for scheduled events |
| `path` | TEXT \| NULL | Request path; NULL for scheduled events |
| `method` | TEXT \| NULL | HTTP method; NULL for scheduled events |
| `platform` | TEXT \| NULL | `'ios'` \| `'android'` where available |
| `app_version` | TEXT \| NULL | App version string where available |
| `metadata` | TEXT \| NULL | Compact JSON; scoped to useful business fields only |
| `created_at` | TEXT | ISO 8601, immutable |

Rows are **append-only**. There is no `updated_at` column.

### Privacy & safety

- No secrets, bearer tokens, or raw request bodies are ever logged
- `CF-Connecting-IP` is the source of truth for IP; the raw `X-Forwarded-For` chain is not stored
- Metadata is explicitly scoped per event — there is no catch-all payload dump
- Only the first IPv4/v6 address from `X-Forwarded-For` is used if `CF-Connecting-IP` is absent

### Admin read endpoint

```
GET /api/admin/tracking/events
```

Requires `X-Admin-Key` header (same as all admin routes).

Query parameters:

| Param | Default | Description |
|---|---|---|
| `page` | `1` | Page number |
| `pageSize` | `20` | Rows per page |
| `event_name` | — | Filter by exact event name |
| `user_id` | — | Filter by user ID |

Results are sorted **newest first**.

### What is intentionally deferred

The following are **out of scope** for this tracking system:

- Mobile-client-initiated event ingestion endpoint
- Meta / Google Ads / Apple Search Ads API integrations
- Campaign attribution and UTM parsing
- Dashboard or BI reporting layer
- Event streaming (Cloudflare Queues, etc.)
- Background aggregation / rollup jobs
- Real-time alerting

---

### Production Deployment Checklist

Before deploying to production, verify:

1. `ENVIRONMENT` is set to `production` (controls auth fallback behavior)
2. `ADMIN_API_KEY` is set via `wrangler secret put` (strong random value)
3. `INTERNAL_API_KEY` is set via `wrangler secret put` (strong random value)
4. `REVENUECAT_WEBHOOK_SECRET` is set and matches RevenueCat dashboard
5. All R2 and provider API keys are configured
6. `.dev.vars` is NOT committed to git (verify with `git status`)
