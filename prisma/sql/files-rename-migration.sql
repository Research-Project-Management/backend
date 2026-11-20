-- =============================================================================
-- Files & Storage Bounded Context: Zero-Data-Loss In-Place Rename Migration
-- =============================================================================
-- Idempotent PostgreSQL DDL script that renames legacy `storage_*` /
-- `upload_sessions` tables and vendor `s3_*` columns in-place prior to
-- `prisma db push` and `db:files-integrity`.
-- =============================================================================

-- 1. Drop legacy BCNF triggers & functions if legacy tables still exist
DO $$
BEGIN
  IF to_regclass('public.storage_files') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_storage_files_parent_guard ON "storage_files";
    DROP TRIGGER IF EXISTS trg_storage_files_blob_size_sync ON "storage_files";
    ALTER TABLE "storage_files" DROP CONSTRAINT IF EXISTS "fk_storage_files_parent_same_space";
    ALTER TABLE "storage_files" DROP CONSTRAINT IF EXISTS "chk_storage_files_folder_invariants";
    ALTER TABLE "storage_files" DROP CONSTRAINT IF EXISTS "chk_storage_files_no_self_parent";
    ALTER TABLE "storage_files" DROP CONSTRAINT IF EXISTS "chk_storage_files_filename_valid";
    ALTER TABLE "storage_files" DROP CONSTRAINT IF EXISTS "chk_storage_files_link_consistency";
  END IF;

  IF to_regclass('public.file_nodes') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_storage_files_parent_guard ON "file_nodes";
    DROP TRIGGER IF EXISTS trg_storage_files_blob_size_sync ON "file_nodes";
    ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "fk_storage_files_parent_same_space";
    ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_folder_invariants";
    ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_no_self_parent";
    ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_filename_valid";
    ALTER TABLE "file_nodes" DROP CONSTRAINT IF EXISTS "chk_storage_files_link_consistency";
  END IF;

  IF to_regclass('public.storage_blobs') IS NOT NULL THEN
    ALTER TABLE "storage_blobs" DROP CONSTRAINT IF EXISTS "chk_storage_blobs_lifecycle";
  END IF;
  IF to_regclass('public.file_blobs') IS NOT NULL THEN
    ALTER TABLE "file_blobs" DROP CONSTRAINT IF EXISTS "chk_storage_blobs_lifecycle";
  END IF;

  IF to_regclass('public.storage_file_versions') IS NOT NULL THEN
    ALTER TABLE "storage_file_versions" DROP CONSTRAINT IF EXISTS "chk_storage_file_versions_version_positive";
  END IF;
  IF to_regclass('public.file_versions') IS NOT NULL THEN
    ALTER TABLE "file_versions" DROP CONSTRAINT IF EXISTS "chk_storage_file_versions_version_positive";
  END IF;

  IF to_regclass('public.upload_sessions') IS NOT NULL THEN
    ALTER TABLE "upload_sessions" DROP CONSTRAINT IF EXISTS "chk_upload_sessions_valid";
  END IF;
  IF to_regclass('public.file_uploads') IS NOT NULL THEN
    ALTER TABLE "file_uploads" DROP CONSTRAINT IF EXISTS "chk_upload_sessions_valid";
  END IF;

  IF to_regclass('public.storage_quotas') IS NOT NULL THEN
    ALTER TABLE "storage_quotas" DROP CONSTRAINT IF EXISTS "chk_storage_quotas_non_negative";
  END IF;
  IF to_regclass('public.space_quotas') IS NOT NULL THEN
    ALTER TABLE "space_quotas" DROP CONSTRAINT IF EXISTS "chk_storage_quotas_non_negative";
  END IF;
END $$;

DROP INDEX IF EXISTS "idx_storage_blobs_gc_ready";
DROP FUNCTION IF EXISTS ensure_storage_file_parent_guard_trigger();
DROP FUNCTION IF EXISTS ensure_storage_file_blob_size_sync_trigger();

-- 2. Rename legacy tables in-place (preserving rows, FKs, and indexes)
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT v.old_name, v.new_name
    FROM (VALUES
      ('storage_files', 'file_nodes'),
      ('storage_file_stars', 'file_stars'),
      ('storage_file_shares', 'file_shares'),
      ('storage_file_versions', 'file_versions'),
      ('storage_blobs', 'file_blobs'),
      ('storage_blob_refs', 'file_blob_refs'),
      ('upload_sessions', 'file_uploads'),
      ('storage_quotas', 'space_quotas')
    ) AS v(old_name, new_name)
  LOOP
    IF to_regclass('public.' || quote_ident(rec.old_name)) IS NOT NULL
       AND to_regclass('public.' || quote_ident(rec.new_name)) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', rec.old_name, rec.new_name);
    END IF;
  END LOOP;
END $$;

-- 3. Rename vendor-prefixed `s3_*` columns in-place
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT v.tbl, v.old_col, v.new_col
    FROM (VALUES
      ('file_blobs', 's3_key', 'storage_key'),
      ('file_blobs', 's3_bucket', 'bucket'),
      ('file_uploads', 's3_upload_id', 'upload_id'),
      ('file_uploads', 's3_key', 'storage_key')
    ) AS v(tbl, old_col, new_col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = rec.tbl
        AND column_name = rec.old_col
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = rec.tbl
        AND column_name = rec.new_col
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', rec.tbl, rec.old_col, rec.new_col);
    END IF;
  END LOOP;
END $$;
