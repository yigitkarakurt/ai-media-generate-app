-- Migration 0011    2026-04-16
-- Catalog redesign: categories, filter previews, featured ordering.

-- ──────────────── Categories ────────────────

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    show_on_home INTEGER NOT NULL DEFAULT 0,
    home_sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
CREATE INDEX IF NOT EXISTS idx_categories_active_sort ON categories(is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_categories_home ON categories(show_on_home, home_sort_order);

-- ──────────────── Filter ↔ Category join ────────────────

CREATE TABLE IF NOT EXISTS filter_categories (
    filter_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (filter_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_fc_category_sort ON filter_categories(category_id, sort_order);

-- ──────────────── Filter Previews ────────────────

CREATE TABLE IF NOT EXISTS filter_previews (
    id TEXT PRIMARY KEY NOT NULL,
    filter_id TEXT NOT NULL,
    preview_url TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'image',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fp_filter_sort ON filter_previews(filter_id, sort_order);

-- At most one primary preview per filter (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_one_primary ON filter_previews(filter_id) WHERE is_primary = 1;

-- ──────────────── Filters — featured ordering ────────────────

ALTER TABLE filters ADD COLUMN featured_sort_order INTEGER NOT NULL DEFAULT 0;

-- ──────────────── Seed: badge-style tags ────────────────

INSERT OR IGNORE INTO tags (id, slug, name, is_active, sort_order, created_at, updated_at) VALUES
    ('55555555-5555-4555-8555-555555555555', 'popular',      'Popular',         1, 5,  datetime('now'), datetime('now')),
    ('66666666-6666-4666-8666-666666666666', 'new',          'New',             1, 6,  datetime('now'), datetime('now')),
    ('77777777-7777-4777-8777-777777777777', 'editors-pick', 'Editor''s Pick',  1, 7,  datetime('now'), datetime('now')),
    ('88888888-8888-4888-8888-888888888888', 'trending',     'Trending',        1, 8,  datetime('now'), datetime('now')),
    ('99999999-9999-4999-8999-999999999999', 'premium',      'Premium',         1, 9,  datetime('now'), datetime('now'));

-- ──────────────── Seed: categories ────────────────

INSERT OR IGNORE INTO categories (id, slug, name, description, is_active, sort_order, show_on_home, home_sort_order, created_at, updated_at) VALUES
    ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'trending',             'Trending',             'The most popular filters right now',              1, 10, 1, 10, datetime('now'), datetime('now')),
    ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'portraits',            'Portraits',            'Studio-quality portrait transformations',          1, 20, 1, 20, datetime('now'), datetime('now')),
    ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', 'product-photography',  'Product Photography',  'Professional product image generation',            1, 30, 1, 30, datetime('now'), datetime('now')),
    ('cccccccc-cccc-4ccc-8ccc-ccccccccccc4', 'artistic-styles',      'Artistic Styles',      'Creative and artistic image transformations',      1, 40, 1, 40, datetime('now'), datetime('now')),
    ('cccccccc-cccc-4ccc-8ccc-ccccccccccc5', 'editors-picks',        'Editor''s Picks',      'Hand-picked by our editorial team',                1, 50, 0, 50, datetime('now'), datetime('now'));

-- ──────────────── Seed: filter ↔ category assignments ────────────────

INSERT OR IGNORE INTO filter_categories (filter_id, category_id, sort_order) VALUES
    -- Cinematic Portrait → trending, portraits
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 10),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 10),
    -- Product Hero Shot → product-photography
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', 10),
    -- Dream Scene → artistic-styles, trending
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', 10),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 20),
    -- Editorial Remix → artistic-styles, editors-picks
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', 20),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5', 10);

-- ──────────────── Seed: filter previews ────────────────

INSERT OR IGNORE INTO filter_previews (id, filter_id, preview_url, media_type, sort_order, is_primary, created_at, updated_at) VALUES
    -- Cinematic Portrait — 3 previews
    ('bbbbbbbb-bb01-4bbb-8bbb-bbbbbbbbb001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
     'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=640&q=80',
     'image', 0, 1, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb01-4bbb-8bbb-bbbbbbbbb002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
     'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=640&q=80',
     'image', 1, 0, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb01-4bbb-8bbb-bbbbbbbbb003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
     'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=640&q=80',
     'image', 2, 0, datetime('now'), datetime('now')),
    -- Product Hero Shot — 3 previews
    ('bbbbbbbb-bb02-4bbb-8bbb-bbbbbbbbb001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
     'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=640&q=80',
     'image', 0, 1, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb02-4bbb-8bbb-bbbbbbbbb002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
     'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=640&q=80',
     'image', 1, 0, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb02-4bbb-8bbb-bbbbbbbbb003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
     'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=640&q=80',
     'image', 2, 0, datetime('now'), datetime('now')),
    -- Dream Scene — 2 previews
    ('bbbbbbbb-bb03-4bbb-8bbb-bbbbbbbbb001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
     'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80',
     'image', 0, 1, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb03-4bbb-8bbb-bbbbbbbbb002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
     'https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=640&q=80',
     'image', 1, 0, datetime('now'), datetime('now')),
    -- Editorial Remix — 3 previews
    ('bbbbbbbb-bb04-4bbb-8bbb-bbbbbbbbb001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
     'https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=640&q=80',
     'image', 0, 1, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb04-4bbb-8bbb-bbbbbbbbb002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
     'https://images.unsplash.com/photo-1469334031218-e382a71b716b?auto=format&fit=crop&w=640&q=80',
     'image', 1, 0, datetime('now'), datetime('now')),
    ('bbbbbbbb-bb04-4bbb-8bbb-bbbbbbbbb003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
     'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=640&q=80',
     'image', 2, 0, datetime('now'), datetime('now'));

-- ──────────────── Update seeded filters with badge tags + featured ordering ────────────────

UPDATE filters SET tag_id = '55555555-5555-4555-8555-555555555555', featured_sort_order = 10
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

UPDATE filters SET tag_id = '66666666-6666-4666-8666-666666666666', featured_sort_order = 20
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

UPDATE filters SET tag_id = '88888888-8888-4888-8888-888888888888'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

UPDATE filters SET tag_id = '77777777-7777-4777-8777-777777777777'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
