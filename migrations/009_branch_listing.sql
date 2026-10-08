-- Listing fields: the rating a venue advertises (not our own booking reviews) and accent-insensitive search.
CREATE EXTENSION IF NOT EXISTS unaccent;
ALTER TABLE catalog.branches ADD COLUMN rating real CHECK(rating IS NULL OR (rating>=0 AND rating<=5));
ALTER TABLE catalog.branches ADD COLUMN review_count integer NOT NULL DEFAULT 0 CHECK(review_count>=0);
