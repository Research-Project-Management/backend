-- =============================================================================
-- Unified Space Container & Library Bounded Context — Schema Integrity & Triggers
-- =============================================================================
-- Safe, idempotent PostgreSQL DDL script for `prisma db push` environments.
--
-- Features:
--   1. Automatic `spaces` synchronization triggers on `users` and `projects`
--      plus strict CHECK constraint ensuring 1 Space = 1 Personal OR 1 Project.
--   2. Populates and maintains `library_items.search_vector` via trigger
--      and creates a GIN index for O(log N) full-text search on title/abstract/venue.
--   3. Creates a functional GIN index on `full_text_indexes` for PDF page FTS.
--   4. Space-scoped partial unique indexes (`space_id` NOT NULL).
-- =============================================================================

-- 0. Space Container Integrity Constraint & Auto-Provisioning Triggers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_spaces_exclusive_owner'
  ) THEN
    ALTER TABLE "spaces"
      ADD CONSTRAINT "chk_spaces_exclusive_owner"
      CHECK (
        ("type" = 'personal' AND "owner_user_id" IS NOT NULL AND "project_id" IS NULL AND "id" = "owner_user_id")
        OR
        ("type" = 'project'  AND "project_id" IS NOT NULL AND "owner_user_id" IS NULL AND "id" = "project_id")
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ensure_user_personal_space_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "spaces" ("id", "type", "owner_user_id", "project_id", "created_at", "updated_at")
  VALUES (NEW.id, 'personal', NEW.id, NULL, NOW(), NOW())
  ON CONFLICT ("id") DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_ensure_personal_space ON "users";
CREATE TRIGGER trg_users_ensure_personal_space
  AFTER INSERT ON "users"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_user_personal_space_trigger();

CREATE OR REPLACE FUNCTION ensure_project_space_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "spaces" ("id", "type", "owner_user_id", "project_id", "created_at", "updated_at")
  VALUES (NEW.id, 'project', NULL, NEW.id, NOW(), NOW())
  ON CONFLICT ("id") DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_ensure_project_space ON "projects";
CREATE TRIGGER trg_projects_ensure_project_space
  AFTER INSERT ON "projects"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_project_space_trigger();

-- Backfill spaces for any existing users and projects
INSERT INTO "spaces" ("id", "type", "owner_user_id", "project_id", "created_at", "updated_at")
SELECT "id", 'personal'::"SpaceType", "id", NULL, "created_at", "updated_at"
FROM "users"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "spaces" ("id", "type", "owner_user_id", "project_id", "created_at", "updated_at")
SELECT "id", 'project'::"SpaceType", NULL, "id", "created_at", "updated_at"
FROM "projects"
ON CONFLICT ("id") DO NOTHING;

-- 1. Trigger function to maintain library_items.search_vector
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

DROP TRIGGER IF EXISTS trg_library_items_search_vector ON "library_items";
CREATE TRIGGER trg_library_items_search_vector
  BEFORE INSERT OR UPDATE OF title, abstract, publication_title
  ON "library_items"
  FOR EACH ROW
  EXECUTE FUNCTION library_items_search_vector_trigger();

-- Backfill existing rows where search_vector is NULL
UPDATE "library_items"
SET "search_vector" =
  setweight(to_tsvector('english', COALESCE("title", '')), 'A') ||
  setweight(to_tsvector('english', COALESCE("abstract", '')), 'B') ||
  setweight(to_tsvector('english', COALESCE("publication_title", '')), 'C')
WHERE "search_vector" IS NULL;

-- Partial index for retracted items
CREATE INDEX IF NOT EXISTS "library_items_retracted_active_partial_idx"
  ON "library_items" ("space_id")
  WHERE "deleted_at" IS NULL AND "is_retracted" = true;

-- 2. Functional GIN index on full_text_indexes for PDF page FTS
CREATE INDEX IF NOT EXISTS "full_text_indexes_tsv_gin_idx"
  ON "full_text_indexes"
  USING GIN (to_tsvector('english', COALESCE("text_content", '')));

-- 3. Space-scoped Unique Indexes (where soft-delete or case-insensitivity applies)
CREATE UNIQUE INDEX IF NOT EXISTS "library_tags_space_lower_name_uq"
  ON "library_tags" ("space_id", LOWER("name"));

CREATE UNIQUE INDEX IF NOT EXISTS "library_collections_space_parent_name_uq"
  ON "library_collections" ("space_id", COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), LOWER("name"))
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "item_identifiers_lower_type_value_idx"
  ON "item_identifiers" (LOWER("type"), LOWER("value"));

CREATE UNIQUE INDEX IF NOT EXISTS "attachments_active_item_file_hash_uq"
  ON "attachments" ("item_id", "file_hash")
  WHERE "deleted_at" IS NULL AND "file_hash" IS NOT NULL;

-- 4. Reader Data Modeling Standardization Partial Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "uq_attachments_one_primary_per_item"
  ON "attachments" ("item_id")
  WHERE "is_primary" = true AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "annotations_active_item_sort_idx"
  ON "annotations" ("item_id", "page_index", "annotation_sort_index")
  WHERE "deleted_at" IS NULL;
