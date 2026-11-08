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

-- =============================================================================
-- 5. Relational Normalization & Consistency Integrity Constraints
-- =============================================================================
-- 5.1 Intra-table consistency: attachment_count <=> has_file and non-negative counters
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_library_items_attachment_consistency'
  ) THEN
    ALTER TABLE "library_items"
      ADD CONSTRAINT "chk_library_items_attachment_consistency"
      CHECK (
        ("attachment_count" = 0 AND "has_file" = false)
        OR
        ("attachment_count" > 0 AND "has_file" = true)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_library_items_counters_positive'
  ) THEN
    ALTER TABLE "library_items"
      ADD CONSTRAINT "chk_library_items_counters_positive"
      CHECK ("attachment_count" >= 0 AND "note_count" >= 0);
  END IF;
END $$;

-- 5.2 Protect annotations.item_id from transitive update anomaly (BCNF/3NF safeguard)
CREATE OR REPLACE FUNCTION ensure_annotation_item_id_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id uuid;
BEGIN
  SELECT item_id INTO v_item_id FROM "attachments" WHERE id = NEW.attachment_id;
  IF v_item_id IS NOT NULL THEN
    NEW.item_id := v_item_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_annotations_ensure_item_id ON "annotations";
CREATE TRIGGER trg_annotations_ensure_item_id
  BEFORE INSERT OR UPDATE OF attachment_id, item_id
  ON "annotations"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_annotation_item_id_trigger();

-- 5.3 Protect user_publications.contributor_id BCNF consistency
CREATE OR REPLACE FUNCTION ensure_user_publication_contributor_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contributor_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "contributors" c WHERE c.id = NEW.contributor_id AND c.item_id = NEW.item_id
    ) THEN
      RAISE EXCEPTION 'Constraint violation: contributor_id % does not belong to item_id %', NEW.contributor_id, NEW.item_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_publications_contributor_integrity ON "user_publications";
CREATE TRIGGER trg_user_publications_contributor_integrity
  BEFORE INSERT OR UPDATE OF contributor_id, item_id
  ON "user_publications"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_user_publication_contributor_trigger();

-- 5.4 Protect library_item_states.last_active_attachment_id BCNF consistency
CREATE OR REPLACE FUNCTION ensure_item_state_attachment_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.last_active_attachment_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "attachments" a WHERE a.id = NEW.last_active_attachment_id AND a.item_id = NEW.item_id
    ) THEN
      RAISE EXCEPTION 'Constraint violation: last_active_attachment_id % does not belong to item_id %', NEW.last_active_attachment_id, NEW.item_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_item_states_attachment_integrity ON "library_item_states";
CREATE TRIGGER trg_item_states_attachment_integrity
  BEFORE INSERT OR UPDATE OF last_active_attachment_id, item_id
  ON "library_item_states"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_item_state_attachment_trigger();

-- 5.5 Auto-maintain full_text_indexes.search_vector for PDF Full-Text Search
CREATE OR REPLACE FUNCTION full_text_indexes_search_vector_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.text_content, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_full_text_indexes_search_vector ON "full_text_indexes";
CREATE TRIGGER trg_full_text_indexes_search_vector
  BEFORE INSERT OR UPDATE OF text_content
  ON "full_text_indexes"
  FOR EACH ROW
  EXECUTE FUNCTION full_text_indexes_search_vector_trigger();

-- Backfill full_text_indexes where search_vector is NULL
UPDATE "full_text_indexes"
SET "search_vector" = to_tsvector('english', COALESCE("text_content", ''))
WHERE "search_vector" IS NULL;

-- 5.6 Prevent cyclic self-parenting in collections
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_library_collections_no_self_parent'
  ) THEN
    ALTER TABLE "library_collections"
      ADD CONSTRAINT "chk_library_collections_no_self_parent"
      CHECK ("parent_id" IS NULL OR "id" <> "parent_id");
  END IF;
END $$;

-- 5.7 Prevent reflexive self-relations (e.g. item citing itself)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_item_relations_no_self_relation'
  ) THEN
    ALTER TABLE "item_relations"
      ADD CONSTRAINT "chk_item_relations_no_self_relation"
      CHECK ("source_item_id" <> "target_item_id");
  END IF;
END $$;

-- 5.8 Ensure non-negative sync sequence values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sync_sequences_positive'
  ) THEN
    ALTER TABLE "sync_sequences"
      ADD CONSTRAINT "chk_sync_sequences_positive"
      CHECK ("current_sequence" >= 0);
  END IF;
END $$;

-- 5.9 Align library_notes space_id with parent library_items when item_id IS NOT NULL
CREATE OR REPLACE FUNCTION ensure_library_note_space_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_space_id uuid;
BEGIN
  IF NEW.item_id IS NOT NULL THEN
    SELECT space_id INTO v_space_id FROM "library_items" WHERE id = NEW.item_id;
    IF v_space_id IS NOT NULL THEN
      NEW.space_id := v_space_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_library_notes_ensure_space ON "library_notes";
CREATE TRIGGER trg_library_notes_ensure_space
  BEFORE INSERT OR UPDATE OF item_id, space_id
  ON "library_notes"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_library_note_space_trigger();
