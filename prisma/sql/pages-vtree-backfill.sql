-- =============================================================================
-- Pages Subsystem: Pre/Post-Push Canonical Virtual Tree Normalization & Backfill
-- =============================================================================
-- Safe, idempotent PostgreSQL script that normalizes existing rows into strict
-- BCNF/3NF POSIX dentry (`page_nodes`) + inode (`page_docs`, `page_files`) form:
--   1. Renames legacy `page_docs.path` and `page_files.name` -> `last_known_path`
--      if pre-push columns still exist.
--   2. Backfills missing `spaces` and default `pages` aggregate root rows for
--      any space owning orphan `page_*` records.
--   3. Backfills non-null `page_id` across `page_docs`, `page_files`,
--      `page_nodes`, `page_snapshots`, `page_snapshot_labels`,
--      `page_track_changes`, and `page_comment_threads`.
--   4. Migrates legacy `page_nodes.is_root_doc` (if present) into `pages.root_doc_id`
--      and normalizes `page_nodes` path/name/depth invariants & deduplication.
--   5. Links `page_files.blob_id` to `storage_blobs.id` where matching CAS blobs exist.
-- =============================================================================

-- 1. Rename legacy columns safely if running prior to `prisma db push`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_docs' AND column_name = 'path'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_docs' AND column_name = 'last_known_path'
  ) THEN
    ALTER TABLE "page_docs" RENAME COLUMN "path" TO "last_known_path";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_files' AND column_name = 'name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_files' AND column_name = 'last_known_path'
  ) THEN
    ALTER TABLE "page_files" RENAME COLUMN "name" TO "last_known_path";
  END IF;
END $$;

-- 2. Ensure `spaces` exist for existing users/projects before creating `pages`
INSERT INTO "spaces" ("id", "type", "owner_user_id", "project_id", "created_at", "updated_at")
SELECT u."id", 'personal'::"SpaceType", u."id", NULL, u."created_at", u."updated_at"
FROM "users" u
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "spaces" ("id", "type", "owner_user_id", "project_id", "created_at", "updated_at")
SELECT p."id", 'project'::"SpaceType", NULL, p."id", p."created_at", p."updated_at"
FROM "projects" p
ON CONFLICT ("id") DO NOTHING;

-- 3. Provision a default Page Aggregate Root for any active space lacking a Page row
WITH spaces_needing_page AS (
  SELECT DISTINCT "space_id" FROM "page_docs" WHERE "space_id" IS NOT NULL
  UNION
  SELECT DISTINCT "space_id" FROM "page_files" WHERE "space_id" IS NOT NULL
  UNION
  SELECT DISTINCT "space_id" FROM "page_nodes" WHERE "space_id" IS NOT NULL
  UNION
  SELECT DISTINCT "space_id" FROM "page_snapshots" WHERE "space_id" IS NOT NULL
  UNION
  SELECT DISTINCT "space_id" FROM "page_snapshot_labels" WHERE "space_id" IS NOT NULL
  UNION
  SELECT DISTINCT "space_id" FROM "page_track_changes" WHERE "space_id" IS NOT NULL
  UNION
  SELECT DISTINCT "space_id" FROM "page_comment_threads" WHERE "space_id" IS NOT NULL
)
INSERT INTO "pages" (
  "id",
  "space_id",
  "title",
  "status",
  "compiler",
  "tex_live_version",
  "spell_check_language",
  "settings",
  "created_at",
  "updated_at"
)
SELECT
  s."space_id",
  s."space_id",
  'Untitled',
  'draft',
  'pdflatex',
  '2024',
  'en_US',
  '{}'::jsonb,
  NOW(),
  NOW()
FROM spaces_needing_page s
JOIN "spaces" sp ON sp."id" = s."space_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "pages" pg WHERE pg."space_id" = s."space_id"
)
ON CONFLICT ("id") DO NOTHING;

-- 4. Backfill non-null valid `page_id` across all Pages child tables
WITH default_page_per_space AS (
  SELECT DISTINCT ON ("space_id")
    "space_id",
    "id" AS "default_page_id"
  FROM "pages"
  ORDER BY "space_id", "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
)
UPDATE "page_docs" d
SET "page_id" = COALESCE(
  (SELECT p."id" FROM "pages" p WHERE p."id" = d."page_id" AND p."space_id" = d."space_id"),
  dp."default_page_id"
)
FROM default_page_per_space dp
WHERE dp."space_id" = d."space_id"
  AND (
    d."page_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "pages" p WHERE p."id" = d."page_id" AND p."space_id" = d."space_id"
    )
  );

WITH default_page_per_space AS (
  SELECT DISTINCT ON ("space_id")
    "space_id",
    "id" AS "default_page_id"
  FROM "pages"
  ORDER BY "space_id", "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
)
UPDATE "page_files" f
SET "page_id" = COALESCE(
  (SELECT p."id" FROM "pages" p WHERE p."id" = f."page_id" AND p."space_id" = f."space_id"),
  dp."default_page_id"
)
FROM default_page_per_space dp
WHERE dp."space_id" = f."space_id"
  AND (
    f."page_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "pages" p WHERE p."id" = f."page_id" AND p."space_id" = f."space_id"
    )
  );

WITH default_page_per_space AS (
  SELECT DISTINCT ON ("space_id")
    "space_id",
    "id" AS "default_page_id"
  FROM "pages"
  ORDER BY "space_id", "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
)
UPDATE "page_nodes" n
SET "page_id" = COALESCE(
  (SELECT p."id" FROM "pages" p WHERE p."id" = n."page_id" AND p."space_id" = n."space_id"),
  (SELECT d."page_id" FROM "page_docs" d WHERE d."id" = n."doc_id" AND d."space_id" = n."space_id"),
  (SELECT f."page_id" FROM "page_files" f WHERE f."id" = n."file_id" AND f."space_id" = n."space_id"),
  dp."default_page_id"
)
FROM default_page_per_space dp
WHERE dp."space_id" = n."space_id"
  AND (
    n."page_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "pages" p WHERE p."id" = n."page_id" AND p."space_id" = n."space_id"
    )
  );

-- Clear inconsistent parent/asset references after page_id alignment
UPDATE "page_nodes" n
SET "parent_id" = NULL
WHERE n."parent_id" IS NOT NULL
  AND (
    n."parent_id" = n."id"
    OR NOT EXISTS (
      SELECT 1 FROM "page_nodes" p
      WHERE p."id" = n."parent_id"
        AND p."page_id" = n."page_id"
        AND p."type" = 'FOLDER'::"PageNodeType"
    )
  );

DELETE FROM "page_nodes" n
WHERE (n."type" = 'FOLDER'::"PageNodeType" AND (n."doc_id" IS NOT NULL OR n."file_id" IS NOT NULL))
   OR (n."type" = 'DOC'::"PageNodeType" AND (n."doc_id" IS NULL OR n."file_id" IS NOT NULL))
   OR (n."type" = 'FILE'::"PageNodeType" AND (n."file_id" IS NULL OR n."doc_id" IS NOT NULL));

-- Backfill page_id on history & review tables
WITH default_page_per_space AS (
  SELECT DISTINCT ON ("space_id")
    "space_id",
    "id" AS "default_page_id"
  FROM "pages"
  ORDER BY "space_id", "deleted_at" NULLS FIRST, "created_at" ASC, "id" ASC
)
UPDATE "page_snapshots" s
SET "page_id" = dp."default_page_id"
FROM default_page_per_space dp
WHERE dp."space_id" = s."space_id"
  AND (
    s."page_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "pages" p WHERE p."id" = s."page_id" AND p."space_id" = s."space_id"
    )
  );

UPDATE "page_snapshot_labels" l
SET "page_id" = COALESCE(
  (SELECT s."page_id" FROM "page_snapshots" s WHERE s."id" = l."snapshot_id" AND s."space_id" = l."space_id"),
  (SELECT p."id" FROM "pages" p WHERE p."space_id" = l."space_id" ORDER BY p."deleted_at" NULLS FIRST, p."created_at" ASC LIMIT 1)
)
WHERE l."page_id" IS NULL
   OR NOT EXISTS (
     SELECT 1 FROM "page_snapshots" s
     WHERE s."id" = l."snapshot_id" AND s."page_id" = l."page_id"
   );

UPDATE "page_track_changes" tc
SET "page_id" = d."page_id"
FROM "page_docs" d
WHERE d."id" = tc."doc_id"
  AND (tc."page_id" IS NULL OR tc."page_id" <> d."page_id");

UPDATE "page_comment_threads" ct
SET "page_id" = d."page_id"
FROM "page_docs" d
WHERE d."id" = ct."doc_id"
  AND (ct."page_id" IS NULL OR ct."page_id" <> d."page_id");

-- 5. Sync pages.root_doc_id from legacy page_nodes.is_root_doc if that column still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_nodes' AND column_name = 'is_root_doc'
  ) THEN
    WITH chosen_root AS (
      SELECT DISTINCT ON (n."page_id")
        n."page_id",
        n."doc_id"
      FROM "page_nodes" n
      JOIN "page_docs" d ON d."id" = n."doc_id" AND d."page_id" = n."page_id"
      WHERE n."type" = 'DOC'::"PageNodeType"
        AND n."is_root_doc" = true
        AND d."deleted_at" IS NULL
      ORDER BY n."page_id", n."sort_order" ASC, n."created_at" ASC
    )
    UPDATE "pages" p
    SET "root_doc_id" = cr."doc_id"
    FROM chosen_root cr
    WHERE p."id" = cr."page_id"
      AND (
        p."root_doc_id" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM "page_docs" d WHERE d."id" = p."root_doc_id" AND d."page_id" = p."id"
        )
      );
  END IF;
END $$;

-- Clear any cross-page root_doc_id on pages
UPDATE "pages" p
SET "root_doc_id" = NULL
WHERE p."root_doc_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "page_docs" d
    WHERE d."id" = p."root_doc_id" AND d."page_id" = p."id"
  );

-- 6. Normalize page_nodes POSIX path, basename name, and depth (>= 1)
DELETE FROM "page_nodes" WHERE trim(both '/' from COALESCE("path", '')) = '';

UPDATE "page_nodes" n
SET
  "path" = '/' || trim(both '/' from regexp_replace(replace(n."path", chr(92), '/'), '/+', '/', 'g')),
  "name" = CASE
    WHEN n."name" IN ('', '.', '..') OR position('/' in n."name") > 0 OR position(chr(92) in n."name") > 0
      THEN regexp_replace(trim(both '/' from regexp_replace(replace(n."path", chr(92), '/'), '/+', '/', 'g')), '^.*/', '')
    ELSE n."name"
  END
WHERE n."path" !~ '^/[^/]+(/[^/]+)*$'
   OR n."name" IN ('', '.', '..')
   OR position('/' in n."name") > 0
   OR position(chr(92) in n."name") > 0;

UPDATE "page_nodes" n
SET "depth" = GREATEST(1, LEAST(32, cardinality(string_to_array(trim(both '/' from n."path"), '/'))))
WHERE n."depth" IS NULL
   OR n."depth" <> GREATEST(1, LEAST(32, cardinality(string_to_array(trim(both '/' from n."path"), '/'))));

-- Deduplicate duplicate (page_id, path) rows before enforcing unique index
WITH ranked_paths AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "page_id", "path" ORDER BY "updated_at" DESC, "id" ASC) AS rn
  FROM "page_nodes"
)
DELETE FROM "page_nodes"
WHERE "id" IN (SELECT "id" FROM ranked_paths WHERE rn > 1);

-- 7. Backfill page_files.blob_id from storage_blobs CAS ledger (when column exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_files' AND column_name = 'blob_id'
  ) THEN
    UPDATE "page_files" f
    SET "blob_id" = sb."id"
    FROM "storage_blobs" sb
    WHERE f."blob_id" IS NULL
      AND (
        sb."s3_key" = f."storage_key"
        OR (
          f."hash" ~ '^[0-9a-fA-F]{64}$'
          AND sb."content_hash" = decode(lower(f."hash"), 'hex')
        )
      );
  END IF;
END $$;
