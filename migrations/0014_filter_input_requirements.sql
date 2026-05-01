-- Migration 0014    2026-05-01
-- Add client-facing media input requirement fields to filters.
-- These fields power the generation_schema contract exposed to mobile clients.
-- No text_to_image or text_to_video operation types are supported in filters.

-- ──────────────── New columns on filters ────────────────

-- Whether this filter requires a user-uploaded media asset
ALTER TABLE filters ADD COLUMN requires_media INTEGER NOT NULL DEFAULT 1;

-- The expected media type the user must upload ('image' or 'video')
ALTER TABLE filters ADD COLUMN input_media_type TEXT NOT NULL DEFAULT 'image';

-- Minimum number of input assets required
ALTER TABLE filters ADD COLUMN min_media_count INTEGER NOT NULL DEFAULT 1;

-- Maximum number of input assets allowed
ALTER TABLE filters ADD COLUMN max_media_count INTEGER NOT NULL DEFAULT 1;

-- JSON array of accepted MIME types, e.g. ["image/jpeg","image/png","image/webp"]
ALTER TABLE filters ADD COLUMN supported_mime_types_json TEXT NOT NULL DEFAULT '["image/jpeg","image/png","image/webp"]';

-- Maximum allowed file size in MB per input asset
ALTER TABLE filters ADD COLUMN max_file_size_mb INTEGER NOT NULL DEFAULT 15;

-- The media type the filter will output ('image' or 'video')
ALTER TABLE filters ADD COLUMN output_media_type TEXT NOT NULL DEFAULT 'image';

-- ──────────────── Migrate existing filters ────────────────

-- All existing image_to_image filters → output_media_type = 'image'
UPDATE filters
SET output_media_type = 'image'
WHERE operation_type = 'image_to_image';

-- Dream Scene was seeded as text_to_image — convert to image_to_image
-- It has a valid image-based prompt that works for image editing.
UPDATE filters
SET
    operation_type          = 'image_to_image',
    output_media_type       = 'image',
    requires_media          = 1,
    input_media_type        = 'image',
    min_media_count         = 1,
    max_media_count         = 1,
    supported_mime_types_json = '["image/jpeg","image/png","image/webp"]',
    max_file_size_mb        = 15,
    prompt_template         = 'Transform the input image into a surreal, optimistic dream-like scene with soft natural light, layered depth, tasteful color contrast, and a clean mobile-wallpaper composition. Avoid text, logos, and distorted anatomy.'
WHERE slug = 'dream-scene';

-- Update Dream Scene config to reflect corrected operation_type
UPDATE filters
SET config = '{"operation_type":"image_to_image","model_key":"alibaba/wan-2.7/image-edit"}'
WHERE slug = 'dream-scene'
  AND json_valid(config);

-- Switch Dream Scene to atlas provider (supports image-to-image)
UPDATE filters
SET
    provider_name    = 'atlas',
    model_key        = 'alibaba/wan-2.7/image-edit',
    provider_model_id = 'alibaba/wan-2.7/image-edit'
WHERE slug = 'dream-scene';

-- ──────────────── Seed: new image_to_video filter ────────────────

INSERT OR IGNORE INTO filters (
    id, name, slug, description, thumbnail_url, category,
    provider_model_id, config, input_media_types, provider_name,
    prompt_template, default_params_json, is_active, coin_cost,
    sort_order, created_at, updated_at,
    tag_id, preview_image_url, model_key,
    operation_type, is_featured, featured_sort_order,
    requires_media, input_media_type, min_media_count, max_media_count,
    supported_mime_types_json, max_file_size_mb, output_media_type
) VALUES (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    'Cinematic Motion',
    'cinematic-motion',
    'Animate your photo into a smooth cinematic video clip.',
    'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=640&q=80',
    'cinematic',
    'wan/image-to-video',
    '{"operation_type":"image_to_video","model_key":"wan/image-to-video"}',
    'image',
    'atlas',
    'Animate the input photo into a smooth cinematic 3-second video clip with natural camera movement, realistic motion blur, and consistent lighting. Preserve the subject identity and scene composition.',
    '{"duration":3}',
    1,
    15,
    50,
    datetime('now'),
    datetime('now'),
    '88888888-8888-4888-8888-888888888888',
    'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=640&q=80',
    'wan/image-to-video',
    'image_to_video',
    0,
    0,
    1, 'image', 1, 1,
    '["image/jpeg","image/png","image/webp"]',
    15,
    'video'
);

-- Seed: previews for Cinematic Motion
INSERT OR IGNORE INTO filter_previews (id, filter_id, preview_url, media_type, sort_order, is_primary, created_at, updated_at) VALUES
    ('bbbbbbbb-bb05-4bbb-8bbb-bbbbbbbbb001',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
     'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=640&q=80',
     'image', 0, 1, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb05-4bbb-8bbb-bbbbbbbbb002',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
     'https://images.unsplash.com/photo-1478720568477-152d9b164e26?auto=format&fit=crop&w=640&q=80',
     'image', 1, 0, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb05-4bbb-8bbb-bbbbbbbbb003',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
     'https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=640&q=80',
     'image', 2, 0, datetime('now'), datetime('now'));

-- Assign Cinematic Motion to trending and artistic-styles categories
INSERT OR IGNORE INTO filter_categories (filter_id, category_id, sort_order) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 30),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', 30);

-- ──────────────── Set input requirements on all existing filters ────────────────
-- (They already default correctly; this is explicit for clarity in case
--  a filter was inserted before defaults were applied)

UPDATE filters
SET
    requires_media            = 1,
    input_media_type          = 'image',
    min_media_count           = 1,
    max_media_count           = 1,
    supported_mime_types_json = '["image/jpeg","image/png","image/webp"]',
    max_file_size_mb          = 15
WHERE operation_type = 'image_to_image'
  AND slug IN ('cinematic-portrait', 'product-hero-shot', 'dream-scene', 'editorial-remix');
