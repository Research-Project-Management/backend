-- =============================================================================
-- Files & Storage Bounded Context — BCNF Schema Integrity, Composite FKs & Triggers
-- =============================================================================
-- Safe, idempotent PostgreSQL DDL script for `prisma db push` environments.
--
-- Features:
--   1. Drops legacy pre-BCNF check constraints & buggy partial GC index.
--   2. Enforces strict BCNF state-machine & value invariants across Files tables.
--   3. Same-space MATCH SIMPLE composite FK on `file_nodes.parent_id` (PG 15+).
--   4. BCNF guard triggers:
--      - `trg_file_nodes_parent_guard`: folder-only parent, same-space, anti-cycle.
--      - `trg_file_nodes_blob_size_sync`: eliminates `blob_id -> size` transitive anomaly.
--   5. Fixed partial orphan-GC index (`status = 'DELETED' AND ref_count = 0`).
-- =============================================================================

-- 1. Drop legacy / outdated constraints and wrong partial index cleanly
ALTER TABLE "file_blobs" DROP CONSTRAINT IF EXISTS "chk_storage_blobs_non_negative";
ALTER TABLE "file_blobs" DROP CONSTRAINT IF EXISTS "chk_storage_blobs_lifecycle";
ALTER TABLE "file_blob_refs" DROP CONSTRAINT IF EXISTS "chk_storage_blob_refs_size_non_negative";
ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_size_non_negative";
ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_folder_no_blob";
ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_folder_invariants";
ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_no_self_parent";
ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_filename_valid";
ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_link_consistency";
ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "fk_storage_files_parent_same_space";
ALTER TABLE "file_versions" DROP CONSTRAINT IF EXISTS "chk_storage_file_versions_valid";
ALTER TABLE "file_versions" DROP CONSTRAINT IF EXISTS "chk_storage_file_versions_version_positive";
ALTER TABLE "file_uploads" DROP CONSTRAINT IF EXISTS "chk_upload_sessions_valid";
ALTER TABLE "space_quotas" DROP CONSTRAINT IF EXISTS "chk_storage_quotas_non_negative";
DROP TRIGGER IF EXISTS trg_storage_files_parent_guard ON "file_nodes";
DROP TRIGGER IF EXISTS trg_storage_files_blob_size_sync ON "file_nodes";
DROP INDEX IF EXISTS "idx_storage_blobs_gc_ready";

-- 2. Strict BCNF & State-Machine CHECK Constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_blobs_lifecycle'
  ) THEN
    ALTER TABLE "file_blobs"
      ADD CONSTRAINT "chk_file_blobs_lifecycle"
      CHECK (
        "size_bytes" >= 0
        AND "ref_count" >= -1
        AND octet_length("content_hash") = 32
        AND "hash_algorithm" IN ('SHA256')
        AND "storage_class" IN ('STANDARD', 'STANDARD_IA', 'GLACIER', 'DEEP_ARCHIVE')
        AND ("ref_count" <> -1 OR ("status" = 'DELETED'::"BlobStatus" AND "claimed_at" IS NOT NULL))
        AND ("status" <> 'DELETED'::"BlobStatus" OR "ref_count" <= 0)
        AND ("tombstone_at" IS NULL OR "ref_count" <= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_nodes_folder_invariants'
  ) THEN
    ALTER TABLE "file_nodes"
      ADD CONSTRAINT "chk_file_nodes_folder_invariants"
      CHECK (
        ("is_folder" = true AND "blob_id" IS NULL AND "size" = 0)
        OR
        ("is_folder" = false AND "size" >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_nodes_no_self_parent'
  ) THEN
    ALTER TABLE "file_nodes"
      ADD CONSTRAINT "chk_file_nodes_no_self_parent"
      CHECK ("parent_id" IS NULL OR "id" <> "parent_id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_nodes_filename_valid'
  ) THEN
    ALTER TABLE "file_nodes"
      ADD CONSTRAINT "chk_file_nodes_filename_valid"
      CHECK (
        char_length(btrim("filename")) BETWEEN 1 AND 255
        AND position('/' in "filename") = 0
        AND position(chr(92) in "filename") = 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_nodes_link_consistency'
  ) THEN
    ALTER TABLE "file_nodes"
      ADD CONSTRAINT "chk_file_nodes_link_consistency"
      CHECK ("linked_to_id" IS NULL OR "linked_to_type" IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_versions_version_positive'
  ) THEN
    ALTER TABLE "file_versions"
      ADD CONSTRAINT "chk_file_versions_version_positive"
      CHECK ("version_number" >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_uploads_valid'
  ) THEN
    ALTER TABLE "file_uploads"
      ADD CONSTRAINT "chk_file_uploads_valid"
      CHECK (
        "total_size" >= 0
        AND "part_size" > 0
        AND "expires_at" > "created_at"
        AND ("expected_hash" IS NULL OR octet_length("expected_hash") = 32)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_space_quotas_non_negative'
  ) THEN
    ALTER TABLE "space_quotas"
      ADD CONSTRAINT "chk_space_quotas_non_negative"
      CHECK ("used_bytes" >= 0 AND "max_bytes" >= 0);
  END IF;
END $$;

-- 3. Same-Space Composite Parent FK on `file_nodes` (requires PostgreSQL 15+)
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'fk_file_nodes_parent_same_space'
     ) THEN
    ALTER TABLE "file_nodes"
      ADD CONSTRAINT "fk_file_nodes_parent_same_space"
      FOREIGN KEY ("parent_id", "space_id")
      REFERENCES "file_nodes" ("id", "space_id")
      MATCH SIMPLE
      ON DELETE SET NULL ("parent_id") ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. BCNF Guard Triggers on `file_nodes`
CREATE OR REPLACE FUNCTION ensure_file_node_parent_guard_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_space_id uuid;
  v_parent_is_folder boolean;
  v_cycle_found integer;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "space_id", "is_folder"
  INTO v_parent_space_id, v_parent_is_folder
  FROM "file_nodes"
  WHERE "id" = NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'FileNode parent_id % does not exist', NEW.parent_id;
  END IF;

  IF v_parent_space_id <> NEW.space_id THEN
    RAISE EXCEPTION 'Cross-space parent assignment rejected: file space % vs parent space %', NEW.space_id, v_parent_space_id;
  END IF;

  IF v_parent_is_folder IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FileNode parent_id % must be a folder', NEW.parent_id;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_folder = true THEN
    WITH RECURSIVE ancestors AS (
      SELECT "id", "parent_id", 1 AS hop
      FROM "file_nodes"
      WHERE "id" = NEW.parent_id
      UNION ALL
      SELECT f."id", f."parent_id", a.hop + 1
      FROM "file_nodes" f
      JOIN ancestors a ON f."id" = a."parent_id"
      WHERE a.hop < 64
    )
    SELECT 1 INTO v_cycle_found
    FROM ancestors
    WHERE "id" = NEW.id
    LIMIT 1;

    IF v_cycle_found IS NOT NULL THEN
      RAISE EXCEPTION 'Cyclic FileNode folder hierarchy detected for node % under parent %', NEW.id, NEW.parent_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_file_nodes_parent_guard ON "file_nodes";
CREATE TRIGGER trg_file_nodes_parent_guard
  BEFORE INSERT OR UPDATE OF parent_id, space_id, is_folder
  ON "file_nodes"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_file_node_parent_guard_trigger();

CREATE OR REPLACE FUNCTION ensure_file_node_blob_size_sync_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_blob_size bigint;
BEGIN
  IF NEW.is_folder = true THEN
    NEW.blob_id := NULL;
    NEW.size := 0;
    RETURN NEW;
  END IF;

  IF NEW.blob_id IS NOT NULL THEN
    SELECT "size_bytes" INTO v_blob_size
    FROM "file_blobs"
    WHERE "id" = NEW.blob_id;

    IF FOUND THEN
      NEW.size := v_blob_size;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_file_nodes_blob_size_sync ON "file_nodes";
CREATE TRIGGER trg_file_nodes_blob_size_sync
  BEFORE INSERT OR UPDATE OF is_folder, blob_id, size
  ON "file_nodes"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_file_node_blob_size_sync_trigger();

-- 5. Fixed Partial Orphan-GC Index for Soft-Deleted Zero-Ref Blobs
CREATE INDEX IF NOT EXISTS "idx_file_blobs_gc_ready"
  ON "file_blobs" ("tombstone_at", "claimed_at")
  WHERE "ref_count" = 0 AND "status" = 'DELETED'::"BlobStatus";
