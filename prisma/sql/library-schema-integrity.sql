-- =============================================================================
-- Library Bounded Context — Schema Integrity, FTS Triggers & Partial Indexes
-- =============================================================================
-- Safe, idempotent PostgreSQL DDL script for `prisma db push` environments.
--
-- Fixes:
--   1. CORE-01 / DB-01: Populates and maintains `items.search_vector` via trigger
--      and creates a GIN index for O(log N) full-text search on title/abstract/venue.
--   2. CORE-02 / DB-10: Creates a functional GIN index on `full_text_indexes`
--      so in-PDF full-text search does not sequentially re-tokenize all pages.
--   3. CORE-04 / DB-03 / ING-14: Adds partial unique indexes for personal-scope
--      (`project_id IS NULL`) and project-scope entities where PostgreSQL
--      nullable composite `UNIQUE` constraints otherwise permit duplicates.
-- =============================================================================

-- 1. Trigger function to maintain items.search_vector
CREATE OR REPLACE FUNCTION library_items_search_vector_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.abstract, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.publication_title, '')), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_items_search_vector ON "items";
CREATE TRIGGER trg_items_search_vector
  BEFORE INSERT OR UPDATE OF title, abstract, publication_title
  ON "items"
  FOR EACH ROW
  EXECUTE FUNCTION library_items_search_vector_trigger();

-- Backfill existing rows where search_vector is NULL
UPDATE "items"
SET "search_vector" =
  setweight(to_tsvector('english', COALESCE("title", '')), 'A') ||
  setweight(to_tsvector('english', COALESCE("abstract", '')), 'B') ||
  setweight(to_tsvector('english', COALESCE("publication_title", '')), 'C')
WHERE "search_vector" IS NULL;

-- Partial index for retracted items
CREATE INDEX IF NOT EXISTS "items_retracted_active_partial_idx"
  ON "items" ("user_id", "project_id")
  WHERE "deleted_at" IS NULL AND "is_retracted" = true;

-- 2. Functional GIN index on full_text_indexes for PDF page FTS
CREATE INDEX IF NOT EXISTS "full_text_indexes_tsv_gin_idx"
  ON "full_text_indexes"
  USING GIN (to_tsvector('english', COALESCE("text_content", '')));

-- 3. Partial Unique Indexes for Personal Scope (project_id IS NULL) and Project Scope
CREATE UNIQUE INDEX IF NOT EXISTS "tags_personal_user_name_uq"
  ON "tags" ("user_id", LOWER("name"))
  WHERE "project_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "tags_project_name_uq"
  ON "tags" ("project_id", LOWER("name"))
  WHERE "project_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "tags_personal_normalized_name_uq"
  ON "tags" ("user_id", "normalized_name")
  WHERE "project_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "tags_project_normalized_name_uq"
  ON "tags" ("project_id", "normalized_name")
  WHERE "project_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "collections_personal_user_parent_name_uq"
  ON "collections" ("user_id", COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), LOWER("name"))
  WHERE "project_id" IS NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "collections_project_parent_name_uq"
  ON "collections" ("project_id", COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), LOWER("name"))
  WHERE "project_id" IS NOT NULL AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "item_identifiers_lower_type_value_idx"
  ON "item_identifiers" (LOWER("type"), LOWER("value"));

CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_runs_personal_idempotency_uq"
  ON "ingestion_runs" ("user_id", "idempotency_key")
  WHERE "project_id" IS NULL AND "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_runs_project_idempotency_uq"
  ON "ingestion_runs" ("project_id", "idempotency_key")
  WHERE "project_id" IS NOT NULL AND "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_personal_key_uq"
  ON "idempotency_records" ("user_id", "idempotency_key")
  WHERE "project_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_project_key_uq"
  ON "idempotency_records" ("project_id", "idempotency_key")
  WHERE "project_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "tombstones_personal_entity_uq"
  ON "tombstones" ("user_id", "entity_type", "entity_id")
  WHERE "project_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "tombstones_project_entity_uq"
  ON "tombstones" ("project_id", "entity_type", "entity_id")
  WHERE "project_id" IS NOT NULL;

-- 4. Reader Data Modeling Standardization Partial Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "uq_attachments_one_primary_per_item"
  ON "attachments" ("item_id")
  WHERE "is_primary" = true AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "annotations_active_item_sort_idx"
  ON "annotations" ("item_id", "page_index", "annotation_sort_index")
  WHERE "deleted_at" IS NULL;

