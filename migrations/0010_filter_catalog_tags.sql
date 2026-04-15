-- Migration number: 0010    2026-04-15
-- Product catalog fields for filters plus reusable single tags.

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
CREATE INDEX IF NOT EXISTS idx_tags_active_sort ON tags(is_active, sort_order);

ALTER TABLE filters ADD COLUMN tag_id TEXT;
ALTER TABLE filters ADD COLUMN preview_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE filters ADD COLUMN model_key TEXT NOT NULL DEFAULT '';
ALTER TABLE filters ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'image_to_image';
ALTER TABLE filters ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;

UPDATE filters
SET model_key = provider_model_id
WHERE model_key = '' AND provider_model_id IS NOT NULL AND provider_model_id != '';

UPDATE filters
SET operation_type = COALESCE(json_extract(config, '$.operation_type'), 'image_to_image')
WHERE config IS NOT NULL
  AND json_valid(config)
  AND json_extract(config, '$.operation_type') IN ('text_to_image', 'image_to_image');

CREATE INDEX IF NOT EXISTS idx_filters_tag ON filters(tag_id);
CREATE INDEX IF NOT EXISTS idx_filters_catalog ON filters(is_active, sort_order);

INSERT OR IGNORE INTO tags (id, slug, name, is_active, sort_order, created_at, updated_at) VALUES
    ('11111111-1111-4111-8111-111111111111', 'portrait', 'Portrait', 1, 10, datetime('now'), datetime('now')),
    ('22222222-2222-4222-8222-222222222222', 'cinematic', 'Cinematic', 1, 20, datetime('now'), datetime('now')),
    ('33333333-3333-4333-8333-333333333333', 'artistic', 'Artistic', 1, 30, datetime('now'), datetime('now')),
    ('44444444-4444-4444-8444-444444444444', 'product', 'Product', 1, 40, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO filters (
    id, name, slug, description, thumbnail_url, category,
    provider_model_id, config, input_media_types, provider_name,
    prompt_template, default_params_json, is_active, coin_cost,
    sort_order, created_at, updated_at, tag_id, preview_image_url,
    model_key, operation_type, is_featured
) VALUES
    (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'Cinematic Portrait',
        'cinematic-portrait',
        'Studio-grade portrait lighting with a cinematic finish.',
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=640&q=80',
        'portrait',
        'alibaba/wan-2.7/image-edit',
        '{"operation_type":"image_to_image","model_key":"alibaba/wan-2.7/image-edit"}',
        'image',
        'atlas',
        'Transform the input photo into a polished cinematic portrait with natural skin texture, dramatic but realistic lighting, shallow depth of field, and high-end editorial color grading. Preserve the subject identity.',
        '{"size":"1024x1024","n":1}',
        1,
        8,
        10,
        datetime('now'),
        datetime('now'),
        '11111111-1111-4111-8111-111111111111',
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=640&q=80',
        'alibaba/wan-2.7/image-edit',
        'image_to_image',
        1
    ),
    (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        'Product Hero Shot',
        'product-hero-shot',
        'Clean commercial product image with premium lighting.',
        'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=640&q=80',
        'product',
        'alibaba/wan-2.7/image-edit',
        '{"operation_type":"image_to_image","model_key":"alibaba/wan-2.7/image-edit"}',
        'image',
        'atlas',
        'Turn the input product photo into a premium e-commerce hero image on a clean modern background with realistic reflections, soft studio lighting, and crisp product detail. Keep the product shape and branding intact.',
        '{"size":"1024x1024","n":1}',
        1,
        10,
        20,
        datetime('now'),
        datetime('now'),
        '44444444-4444-4444-8444-444444444444',
        'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=640&q=80',
        'alibaba/wan-2.7/image-edit',
        'image_to_image',
        1
    ),
    (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        'Dream Scene',
        'dream-scene',
        'Generate a soft surreal image from the backend prompt.',
        'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80',
        'artistic',
        'bytedance-seed/seedream-4.5',
        '{"operation_type":"text_to_image","model_key":"bytedance-seed/seedream-4.5"}',
        'image',
        'openrouter',
        'Create a surreal, optimistic dream scene with soft natural light, layered depth, tasteful color contrast, and a clean mobile-wallpaper composition. Avoid text, logos, and distorted anatomy.',
        '{"size":"1024x1024"}',
        1,
        6,
        30,
        datetime('now'),
        datetime('now'),
        '33333333-3333-4333-8333-333333333333',
        'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80',
        'bytedance-seed/seedream-4.5',
        'text_to_image',
        0
    ),
    (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        'Editorial Remix',
        'editorial-remix',
        'Restyle an image with fashion editorial color and composition.',
        'https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=640&q=80',
        'cinematic',
        'bytedance-seed/seedream-4.5',
        '{"operation_type":"image_to_image","model_key":"bytedance-seed/seedream-4.5"}',
        'image',
        'openrouter',
        'Restyle the input image as a refined fashion editorial frame with confident composition, natural detail preservation, controlled contrast, and premium magazine-grade color. Avoid adding text.',
        '{"size":"1024x1024"}',
        1,
        7,
        40,
        datetime('now'),
        datetime('now'),
        '22222222-2222-4222-8222-222222222222',
        'https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=640&q=80',
        'bytedance-seed/seedream-4.5',
        'image_to_image',
        0
    );
