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
├── core/
│   ├── assets/
│   │   └── client.ts               # Client-safe asset type + toClientAsset() helper
│   ├── db/
│   │   └── schema.ts               # TypeScript types matching D1 tables
│   └── generation/
│       ├── types.ts                 # Provider-agnostic generation interfaces
│       ├── dispatch.ts              # Provider router (routes to registered adapters)
│       ├── sync.ts                  # Job sync logic (single + batch) + output handling
│       ├── scheduled.ts             # Cron trigger handler for automatic batch sync
│       └── providers/
│           ├── index.ts             # Provider registry
│           └── atlas.ts             # Atlas Cloud adapter (submit + status polling)
│
├── lib/
│   └── r2.ts                       # R2 presigned URL generation (upload + read)
│
├── middleware/
│   └── dev-auth.ts                  # Temporary dev auth (X-Dev-User-Id header)
│
└── modules/
    ├── health/
    │   └── routes.ts                # GET /api/health, GET /api/version
    ├── mobile/
    │   ├── assets.ts                # GET /api/mobile/assets, GET /api/mobile/assets/:id
    │   ├── filters.ts               # GET /api/mobile/filters
    │   ├── generations.ts           # GET,POST /api/mobile/generations
    │   ├── uploads.ts               # POST /api/mobile/uploads/request, /confirm
    │   └── devices.ts               # POST,DELETE /api/mobile/devices/push-token
    ├── admin/
    │   ├── dashboard.ts             # GET /api/admin/dashboard
    │   ├── users.ts                 # GET /api/admin/users
    │   ├── jobs.ts                  # GET /api/admin/jobs, POST cancel
    │   ├── assets.ts                # GET,DELETE /api/admin/assets
    │   ├── filters.ts               # Full CRUD /api/admin/filters
    │   └── settings.ts             # GET,PUT,DELETE /api/admin/settings
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
```

Adding a new provider means creating a new adapter file (e.g., `providers/fal.ts`), implementing
`GenerationProvider`, and registering it in the provider registry.

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

## Route Groups

| Group | Base Path | Auth | Description |
|-------|-----------|------|-------------|
| Health | `/api/health`, `/api/version` | None | Service health and version |
| Mobile Uploads | `/api/mobile/uploads` | User | Request presigned URLs + confirm uploads |
| Mobile Assets | `/api/mobile/assets` | User | List/view own assets |
| Mobile Filters | `/api/mobile/filters` | User | Browse active filters |
| Mobile Generations | `/api/mobile/generations` | User | Submit and track generation jobs |
| Mobile Devices | `/api/mobile/devices` | User | Register push notification tokens |
| Admin Dashboard | `/api/admin/dashboard` | Admin | Aggregate stats |
| Admin Users | `/api/admin/users` | Admin | User management |
| Admin Jobs | `/api/admin/jobs` | Admin | Job monitoring and cancellation |
| Admin Assets | `/api/admin/assets` | Admin | Asset management |
| Admin Filters | `/api/admin/filters` | Admin | Filter CRUD |
| Admin Settings | `/api/admin/settings` | Admin | Key-value config store |
| Internal Generations | `/api/internal/generations` | None* | Job sync (single + batch) |

\* Internal routes are service-to-service. Secure with shared secret or Cloudflare Access in production.

| Trigger | Schedule | Description |
|---------|----------|-------------|
| Cron | `*/2 * * * *` | Automatic batch sync of pending generation jobs |

## Authentication (Development)

During development, use the `X-Dev-User-Id` header to simulate an authenticated user:

```bash
curl -H "X-Dev-User-Id: test-user-123" http://localhost:8787/api/mobile/assets
```

This header is **blocked in production**. Replace with real JWT auth before deploying.

## Database Tables

| Table | Description |
|-------|-------------|
| `users` | User accounts (email, auth provider, role) |
| `assets` | Uploaded/generated media files with `kind` (input/output), linked to R2 |
| `filters` | AI generation filter catalog |
| `generation_jobs` | Generation job queue with status tracking |
| `device_push_tokens` | Push notification tokens per device |
| `admin_settings` | Key-value configuration store |

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

# Deploy
npm run deploy

# Run tests
npm test

# Regenerate Cloudflare types
npm run cf-typegen
```

## Media Validation

| Constraint | Value |
|-----------|-------|
| Max file size | 100 MB |
| Allowed image types | JPEG, PNG, WebP, HEIC, HEIF |
| Allowed video types | MP4, QuickTime (MOV), WebM |
| Upload URL expiry | 10 minutes |

## Next Implementation Steps

1. **Push notifications** — Notify users when generation completes/fails
2. **Webhook receiver** — Optional provider callback endpoint for faster status updates
3. **Reference image support** — Multi-image input for providers that support it
4. **Second provider** — fal.ai adapter using the same provider router
5. **Authentication middleware** — JWT verification, replace dev-auth
6. **Admin auth** — Separate admin authentication/authorization
7. **Internal route auth** — Shared secret or Cloudflare Access for service-to-service routes
8. **Rate limiting** — Per-user and per-endpoint limits
9. **Scheduled cleanup** — Cron trigger for stale queued jobs and orphaned assets
10. **Asset deletion** — Allow users to delete their own assets (R2 + D1 cleanup)
11. **Job polling / SSE** — Optional real-time status updates for the mobile client

### Intentionally Deferred (Not in Current Implementation)

- Push notifications on job completion
- Webhook receiver for provider callbacks
- Reference image / multi-image input support
- User-provided custom prompts (prompts come from filter config only)
- Second provider integration (fal.ai, etc.)
- Cancel via Atlas API
- Public unauthenticated asset URLs
- Admin dashboard metrics overhaul
