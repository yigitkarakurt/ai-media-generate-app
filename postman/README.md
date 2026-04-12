# Postman Artifacts

This directory contains a Postman collection and local environment for manually testing the current Cloudflare Workers backend.

## Files

- `ai-media-generate-app.postman_collection.json`
- `local-dev.postman_environment.json`

## Import

1. Start the Worker locally with `npm run dev`.
2. In Postman, import `postman/ai-media-generate-app.postman_collection.json`.
3. Import `postman/local-dev.postman_environment.json`.
4. Select the `AI Media Generate App - Local Dev` environment.

## Variables

Set or confirm these environment variables before running the main flow:

- `baseUrl`: local Worker URL, usually `http://127.0.0.1:8787`.
- `devUserId`: value sent as `X-Dev-User-Id` for mobile routes that use dev auth.
- `filterId` / `filterSlug`: populated by `Mobile / Filters / List Active Filters` if filters exist, or by `Admin / Filters / Create Filter`.
- `assetId`: populated by `Mobile / Uploads / Request Upload URL`.
- `uploadUrl`: populated by `Mobile / Uploads / Request Upload URL`; used by the direct R2 upload template.
- `generationId`: populated by `Mobile / Generations / Create Generation`.
- `outputAssetId`: populated by `Internal / Sync Generation by ID` or completed generation detail when output exists.
- `atlasModelId`: only used by the admin create-filter example. Set this to a valid Atlas model ID before using that filter for live generation.

Do not add an Atlas API key to Postman. The backend reads `ATLASCLOUD_API_KEY` from Worker secrets; clients never send it.

## Recommended Test Flow

1. Run `Health / Health Check`.
2. Run `Mobile / Filters / List Active Filters`.
3. If no filters exist, run `Admin / Filters / Create Filter`, then run `Mobile / Filters / List Active Filters` again.
4. Run `Mobile / Uploads / Request Upload URL`.
5. Run `Mobile / Uploads / Upload File to Signed R2 URL`: choose a local file in Postman's Body file picker before sending. This request goes directly to R2, not to the Worker.
6. Run `Mobile / Uploads / Confirm Upload`.
7. Run `Mobile / Generations / Create Generation`.
8. Run `Mobile / Generations / Get Generation Detail`.
9. If needed, run `Internal / Sync Generation by ID` or `Internal / Sync Pending Generations`.
10. Run `Mobile / Generations / Get Generation Detail` again.
11. Run `Mobile / Assets / Get Output Asset` after `outputAssetId` is set.
12. Run `Mobile / Assets / List Assets`.
13. Use the `Admin` folder for optional inspection and cleanup.

## Auth Notes

Mobile upload, asset, and generation routes require `X-Dev-User-Id` in the current development auth middleware. This header is rejected when `ENVIRONMENT` is `production`.

Mobile filter routes are currently public in code. Mobile device push-token routes are placeholders and currently do not enforce auth or parse request bodies.

Admin routes currently have no admin auth middleware in code. Treat them as admin-only and protect them before production use.

Internal generation sync routes currently have no shared-secret middleware in code. They are service-to-service routes and are not mobile-safe.

There is no implemented `internalSecret` header yet, so the collection does not define or send one.

## Known Limitations

- Direct R2 upload uses a presigned URL that expires after 600 seconds. Rerun `Request Upload URL` if it expires.
- The signed R2 upload step cannot choose a local file automatically from a static collection; select the file manually in Postman.
- `Admin / Filters / Create Filter` can create a filter record, but successful generation still depends on a valid backend Atlas API key and a valid `atlasModelId`.
- `Mobile / Devices` routes return placeholder 501 responses.
- `Admin / Assets / Delete Asset` deletes only the D1 row; current code does not delete the R2 object.
