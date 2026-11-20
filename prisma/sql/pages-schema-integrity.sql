-- =============================================================================
-- Pages Subsystem: Virtual Tree Schema Integrity, Composite FKs & Triggers
-- =============================================================================
-- Safe, idempotent PostgreSQL DDL script for `prisma db push` environments.
--
-- Features:
--   1. Strict same-page MATCH SIMPLE composite foreign keys on `page_nodes`,
--      `pages.root_doc_id`, `page_track_changes`, `page_comment_threads`, and
--      `page_snapshot_labels` preventing cross-page tree/asset attachment.
--   2. Exclusive-arc CHECK constraint (`FOLDER` XOR `DOC` XOR `FILE`) & no self-parent.
--   3. POSIX path/name/depth invariants CHECK constraint & non-negative counters.
--   4. Root/sibling uniqueness (`COALESCE(parent_id, sentinel)`) and
--      `varchar_pattern_ops` subtree prefix index (`O(log N)` move/delete).
--   5. Folder-parent & cycle-prevention guard trigger (`trg_page_nodes_parent_guard`)
--      plus universal `pages.root_doc_id` same-page trigger.
-- =============================================================================

-- 1. Same-Page Composite Foreign Keys (MATCH SIMPLE)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_nodes_parent_same_page'
  ) THEN
    ALTER TABLE "page_nodes"
      ADD CONSTRAINT "fk_page_nodes_parent_same_page"
      FOREIGN KEY ("parent_id", "page_id")
      REFERENCES "page_nodes" ("id", "page_id")
      MATCH SIMPLE
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_nodes_doc_same_page'
  ) THEN
    ALTER TABLE "page_nodes"
      ADD CONSTRAINT "fk_page_nodes_doc_same_page"
      FOREIGN KEY ("doc_id", "page_id")
      REFERENCES "page_docs" ("id", "page_id")
      MATCH SIMPLE
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_nodes_file_same_page'
  ) THEN
    ALTER TABLE "page_nodes"
      ADD CONSTRAINT "fk_page_nodes_file_same_page"
      FOREIGN KEY ("file_id", "page_id")
      REFERENCES "page_files" ("id", "page_id")
      MATCH SIMPLE
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_track_changes_doc_same_page'
  ) THEN
    ALTER TABLE "page_track_changes"
      ADD CONSTRAINT "fk_page_track_changes_doc_same_page"
      FOREIGN KEY ("doc_id", "page_id")
      REFERENCES "page_docs" ("id", "page_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_comment_threads_doc_same_page'
  ) THEN
    ALTER TABLE "page_comment_threads"
      ADD CONSTRAINT "fk_page_comment_threads_doc_same_page"
      FOREIGN KEY ("doc_id", "page_id")
      REFERENCES "page_docs" ("id", "page_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_snapshot_labels_snapshot_same_page'
  ) THEN
    ALTER TABLE "page_snapshot_labels"
      ADD CONSTRAINT "fk_page_snapshot_labels_snapshot_same_page"
      FOREIGN KEY ("snapshot_id", "page_id")
      REFERENCES "page_snapshots" ("id", "page_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Partial ON DELETE SET NULL (column list) requires PostgreSQL 15+
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'fk_pages_root_doc_same_page'
     ) THEN
    ALTER TABLE "pages"
      ADD CONSTRAINT "fk_pages_root_doc_same_page"
      FOREIGN KEY ("root_doc_id", "id")
      REFERENCES "page_docs" ("id", "page_id")
      MATCH SIMPLE
      ON DELETE SET NULL ("root_doc_id") ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. Exclusive-Arc, Self-Parent, POSIX Path/Depth & Counter Check Constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_page_nodes_exclusive_arc'
  ) THEN
    ALTER TABLE "page_nodes"
      ADD CONSTRAINT "chk_page_nodes_exclusive_arc"
      CHECK (
        ("type" = 'FOLDER'::"PageNodeType" AND "doc_id" IS NULL     AND "file_id" IS NULL)
        OR
        ("type" = 'DOC'::"PageNodeType"    AND "doc_id" IS NOT NULL AND "file_id" IS NULL)
        OR
        ("type" = 'FILE'::"PageNodeType"   AND "doc_id" IS NULL     AND "file_id" IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_page_nodes_no_self_parent'
  ) THEN
    ALTER TABLE "page_nodes"
      ADD CONSTRAINT "chk_page_nodes_no_self_parent"
      CHECK ("parent_id" IS NULL OR "id" <> "parent_id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_page_nodes_path_depth_invariants'
  ) THEN
    ALTER TABLE "page_nodes"
      ADD CONSTRAINT "chk_page_nodes_path_depth_invariants"
      CHECK (
        char_length("name") BETWEEN 1 AND 255
        AND "name" NOT IN ('.', '..')
        AND position('/' in "name") = 0
        AND position(chr(92) in "name") = 0
        AND left("path", 1) = '/'
        AND char_length("path") >= 2
        AND right("path", 1) <> '/'
        AND position('//' in "path") = 0
        AND (
          ("parent_id" IS NULL AND "depth" = 1 AND "path" = '/' || "name")
          OR
          ("parent_id" IS NOT NULL AND "depth" BETWEEN 2 AND 32 AND right("path", char_length("name") + 1) = '/' || "name")
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_page_docs_counters_non_negative'
  ) THEN
    ALTER TABLE "page_docs"
      ADD CONSTRAINT "chk_page_docs_counters_non_negative"
      CHECK ("size_bytes" >= 0 AND "rev" >= 0 AND "version" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_page_files_counters_non_negative'
  ) THEN
    ALTER TABLE "page_files"
      ADD CONSTRAINT "chk_page_files_counters_non_negative"
      CHECK ("size_bytes" >= 0 AND "rev" >= 0);
  END IF;
END $$;

-- 3. Sibling Uniqueness (NULL-safe for root-level siblings) & Prefix Pattern Index
CREATE UNIQUE INDEX IF NOT EXISTS "uq_page_nodes_sibling_name"
  ON "page_nodes" (
    "page_id",
    COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "name"
  );

CREATE INDEX IF NOT EXISTS "idx_page_nodes_page_path_pattern"
  ON "page_nodes" ("page_id", "path" varchar_pattern_ops);

-- 4. Folder-Parent & Cycle-Prevention Trigger + root_doc_id Same-Page Guard Trigger
CREATE OR REPLACE FUNCTION ensure_page_node_parent_guard_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_type "PageNodeType";
  v_parent_page_id uuid;
  v_cycle_found integer;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "type", "page_id"
  INTO v_parent_type, v_parent_page_id
  FROM "page_nodes"
  WHERE "id" = NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PageNode parent_id % does not exist', NEW.parent_id;
  END IF;

  IF v_parent_page_id <> NEW.page_id THEN
    RAISE EXCEPTION 'Cross-page parent assignment rejected: node page % vs parent page %', NEW.page_id, v_parent_page_id;
  END IF;

  IF v_parent_type <> 'FOLDER'::"PageNodeType" THEN
    RAISE EXCEPTION 'Parent node % must be of type FOLDER (found %)', NEW.parent_id, v_parent_type;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.type = 'FOLDER'::"PageNodeType" THEN
    WITH RECURSIVE ancestors AS (
      SELECT "id", "parent_id", 1 AS hop
      FROM "page_nodes"
      WHERE "id" = NEW.parent_id
      UNION ALL
      SELECT p."id", p."parent_id", a.hop + 1
      FROM "page_nodes" p
      JOIN ancestors a ON p."id" = a."parent_id"
      WHERE a.hop < 33
    )
    SELECT 1 INTO v_cycle_found
    FROM ancestors
    WHERE "id" = NEW.id
    LIMIT 1;

    IF v_cycle_found IS NOT NULL THEN
      RAISE EXCEPTION 'Cyclic PageNode folder hierarchy detected for node % under parent %', NEW.id, NEW.parent_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_page_nodes_parent_guard ON "page_nodes";
CREATE TRIGGER trg_page_nodes_parent_guard
  BEFORE INSERT OR UPDATE OF parent_id, page_id, type
  ON "page_nodes"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_page_node_parent_guard_trigger();

CREATE OR REPLACE FUNCTION ensure_page_root_doc_same_page_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_doc_page_id uuid;
BEGIN
  IF NEW.root_doc_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "page_id" INTO v_doc_page_id
  FROM "page_docs"
  WHERE "id" = NEW.root_doc_id;

  IF NOT FOUND OR v_doc_page_id <> NEW.id THEN
    RAISE EXCEPTION 'Page root_doc_id % must reference a PageDoc owned by page %', NEW.root_doc_id, NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pages_root_doc_same_page ON "pages";
CREATE TRIGGER trg_pages_root_doc_same_page
  BEFORE INSERT OR UPDATE OF root_doc_id
  ON "pages"
  FOR EACH ROW
  EXECUTE FUNCTION ensure_page_root_doc_same_page_trigger();

-- 5. Stored Procedure: Atomic Set-Based Page + Virtual Tree Deep Clone
CREATE OR REPLACE PROCEDURE clone_page_virtual_tree(
  p_source_page_id uuid,
  p_new_page_id uuid,
  p_space_id uuid,
  p_new_title varchar,
  p_actor_id uuid DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_src_page RECORD;
  v_source_root_doc_id uuid;
  v_new_root_doc_id uuid;
  v_doc_map jsonb := '{}'::jsonb;
  v_file_map jsonb := '{}'::jsonb;
  v_node_map jsonb := '{}'::jsonb;
  v_max_depth integer := 0;
  v_depth integer;
BEGIN
  SELECT *
  INTO v_src_page
  FROM "pages"
  WHERE "id" = p_source_page_id
    AND "space_id" = p_space_id
    AND "deleted_at" IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source page % not found in space %', p_source_page_id, p_space_id;
  END IF;

  -- Determine effective source root_doc_id (fallback to earliest active doc in page)
  v_source_root_doc_id := v_src_page.root_doc_id;
  IF v_source_root_doc_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM "page_docs"
    WHERE "id" = v_source_root_doc_id
      AND "space_id" = p_space_id
      AND "page_id" = p_source_page_id
      AND "deleted_at" IS NULL
  ) THEN
    SELECT "id" INTO v_source_root_doc_id
    FROM "page_docs"
    WHERE "space_id" = p_space_id
      AND "page_id" = p_source_page_id
      AND "deleted_at" IS NULL
    ORDER BY "created_at" ASC
    LIMIT 1;
  END IF;

  -- 1. Insert Page Aggregate Root first with root_doc_id = NULL
  INSERT INTO "pages" (
    "id", "space_id", "root_doc_id", "title", "description", "status",
    "compiler", "tex_live_version", "spell_check_language", "settings",
    "created_by_id", "created_at", "updated_at"
  ) VALUES (
    p_new_page_id,
    p_space_id,
    NULL,
    p_new_title,
    v_src_page.description,
    'draft',
    v_src_page.compiler,
    v_src_page.tex_live_version,
    v_src_page.spell_check_language,
    COALESCE(v_src_page.settings, '{}'::jsonb),
    COALESCE(p_actor_id, v_src_page.created_by_id),
    NOW(),
    NOW()
  );

  -- 2. Map and set-based clone all active PageDoc rows in RAM (0 bytes lines over network)
  SELECT COALESCE(
    jsonb_object_agg(
      d."id"::text,
      to_jsonb(
        (CASE WHEN d."id" = v_source_root_doc_id THEN p_new_page_id ELSE gen_random_uuid() END)::text
      )
    ),
    '{}'::jsonb
  )
  INTO v_doc_map
  FROM "page_docs" d
  WHERE d."space_id" = p_space_id
    AND d."page_id" = p_source_page_id
    AND d."deleted_at" IS NULL;

  INSERT INTO "page_docs" (
    "id", "space_id", "page_id", "last_known_path", "lines",
    "rev", "version", "ranges", "hash", "size_bytes",
    "in_storage", "storage_key", "deleted_at", "created_at", "updated_at"
  )
  SELECT
    (v_doc_map ->> d."id"::text)::uuid,
    p_space_id,
    p_new_page_id,
    d."last_known_path",
    d."lines",
    1,
    1,
    CASE
      WHEN d."id" = v_source_root_doc_id THEN
        jsonb_set(
          CASE WHEN jsonb_typeof(d."ranges") = 'object' THEN d."ranges" ELSE '{}'::jsonb END,
          '{title}',
          to_jsonb(p_new_title::text),
          true
        )
      ELSE
        CASE WHEN jsonb_typeof(d."ranges") = 'object' THEN d."ranges" ELSE '{}'::jsonb END
    END,
    d."hash",
    d."size_bytes",
    false,
    NULL,
    NULL,
    NOW(),
    NOW()
  FROM "page_docs" d
  WHERE d."space_id" = p_space_id
    AND d."page_id" = p_source_page_id
    AND d."deleted_at" IS NULL;

  -- 3. Wire pages.root_doc_id to cloned root PageDoc
  IF v_source_root_doc_id IS NOT NULL AND (v_doc_map ? v_source_root_doc_id::text) THEN
    v_new_root_doc_id := (v_doc_map ->> v_source_root_doc_id::text)::uuid;
    UPDATE "pages"
    SET "root_doc_id" = v_new_root_doc_id,
        "updated_at" = NOW()
    WHERE "id" = p_new_page_id
      AND "space_id" = p_space_id;
  END IF;

  -- 4. Map and set-based clone all active PageFile rows + increment FileBlob CAS ref_count
  SELECT COALESCE(
    jsonb_object_agg(f."id"::text, to_jsonb(gen_random_uuid()::text)),
    '{}'::jsonb
  )
  INTO v_file_map
  FROM "page_files" f
  WHERE f."space_id" = p_space_id
    AND f."page_id" = p_source_page_id
    AND f."deleted_at" IS NULL;

  INSERT INTO "page_files" (
    "id", "space_id", "page_id", "blob_id", "last_known_path",
    "mime_type", "size_bytes", "hash", "storage_key", "bucket_name",
    "rev", "deleted_at", "created_at", "updated_at"
  )
  SELECT
    (v_file_map ->> f."id"::text)::uuid,
    p_space_id,
    p_new_page_id,
    f."blob_id",
    f."last_known_path",
    f."mime_type",
    f."size_bytes",
    f."hash",
    f."storage_key",
    f."bucket_name",
    0,
    NULL,
    NOW(),
    NOW()
  FROM "page_files" f
  WHERE f."space_id" = p_space_id
    AND f."page_id" = p_source_page_id
    AND f."deleted_at" IS NULL;

  UPDATE "file_blobs" b
  SET "ref_count" = b."ref_count" + sub.cnt,
      "tombstone_at" = NULL
  FROM (
    SELECT "blob_id", COUNT(*)::int AS cnt
    FROM "page_files"
    WHERE "space_id" = p_space_id
      AND "page_id" = p_new_page_id
      AND "deleted_at" IS NULL
      AND "blob_id" IS NOT NULL
    GROUP BY "blob_id"
  ) sub
  WHERE b."id" = sub."blob_id";

  -- 5. Map and clone PageNode Virtual Tree level-by-level (depth 1..max_depth)
  SELECT
    COALESCE(jsonb_object_agg(n."id"::text, to_jsonb(gen_random_uuid()::text)), '{}'::jsonb),
    COALESCE(MAX(n."depth"), 0)
  INTO v_node_map, v_max_depth
  FROM "page_nodes" n
  WHERE n."space_id" = p_space_id
    AND n."page_id" = p_source_page_id
    AND (
      (n."type" = 'FOLDER'::"PageNodeType" AND n."doc_id" IS NULL AND n."file_id" IS NULL)
      OR (n."type" = 'DOC'::"PageNodeType" AND n."doc_id" IS NOT NULL AND (v_doc_map ? n."doc_id"::text))
      OR (n."type" = 'FILE'::"PageNodeType" AND n."file_id" IS NOT NULL AND (v_file_map ? n."file_id"::text))
    );

  FOR v_depth IN 1..v_max_depth LOOP
    INSERT INTO "page_nodes" (
      "id", "space_id", "page_id", "parent_id",
      "type", "name", "path", "depth",
      "doc_id", "file_id", "sort_order", "created_at", "updated_at"
    )
    SELECT
      (v_node_map ->> n."id"::text)::uuid,
      p_space_id,
      p_new_page_id,
      CASE WHEN n."parent_id" IS NULL THEN NULL ELSE (v_node_map ->> n."parent_id"::text)::uuid END,
      n."type",
      n."name",
      n."path",
      GREATEST(1, n."depth"),
      CASE WHEN n."doc_id" IS NULL THEN NULL ELSE (v_doc_map ->> n."doc_id"::text)::uuid END,
      CASE WHEN n."file_id" IS NULL THEN NULL ELSE (v_file_map ->> n."file_id"::text)::uuid END,
      n."sort_order",
      NOW(),
      NOW()
    FROM "page_nodes" n
    WHERE n."space_id" = p_space_id
      AND n."page_id" = p_source_page_id
      AND n."depth" = v_depth
      AND (v_node_map ? n."id"::text)
      AND (n."parent_id" IS NULL OR (v_node_map ? n."parent_id"::text));
  END LOOP;
END;
$$;
