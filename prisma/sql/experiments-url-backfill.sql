-- =============================================================================
-- Experiments & Files Subsystem: Legacy URL Path Backfill Migration
-- =============================================================================
-- Idempotent PostgreSQL backfill script that normalizes legacy hardcoded URLs:
--   - `/api/v1/storage/files/`      -> `/api/v1/experiments/files/`
--   - `/api/v1/core/storage/local-` -> `/api/v1/files/local-`
--   - `/api/v1/storage/local-`      -> `/api/v1/files/local-`
-- Safe to execute multiple times and guarded by information_schema checks.
-- =============================================================================

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT v.tbl, v.col
    FROM (VALUES
      ('attachments', 'url'),
      ('attachment_revisions', 'url'),
      ('library_items', 'url'),
      ('entity_attachments', 'url'),
      ('user_profiles', 'avatar_url'),
      ('user_profiles', 'cover_image_url'),
      ('projects', 'avatar'),
      ('project_templates', 'avatar'),
      ('conversations', 'avatar'),
      ('pages', 'pdf_thumbnail')
    ) AS v(tbl, col)
    JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = v.tbl
     AND c.column_name = v.col
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = replace(replace(replace(%I, ''/api/v1/storage/files/'', ''/api/v1/experiments/files/''), ''/api/v1/core/storage/local-'', ''/api/v1/files/local-''), ''/api/v1/storage/local-'', ''/api/v1/files/local-'') WHERE %I LIKE ''%%/api/v1/storage/%%'' OR %I LIKE ''%%/api/v1/core/storage/%%''',
      rec.tbl, rec.col, rec.col, rec.col, rec.col
    );
  END LOOP;

  FOR rec IN
    SELECT v.tbl, v.col
    FROM (VALUES
      ('storage_files', 'metadata'),
      ('attachments', 'metadata'),
      ('library_items', 'metadata'),
      ('entity_attachments', 'metadata'),
      ('work_item_comments', 'attachments'),
      ('messages', 'attachments')
    ) AS v(tbl, col)
    JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = v.tbl
     AND c.column_name = v.col
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = replace(replace(replace(%I::text, ''/api/v1/storage/files/'', ''/api/v1/experiments/files/''), ''/api/v1/core/storage/local-'', ''/api/v1/files/local-''), ''/api/v1/storage/local-'', ''/api/v1/files/local-'')::jsonb WHERE %I IS NOT NULL AND (%I::text LIKE ''%%/api/v1/storage/%%'' OR %I::text LIKE ''%%/api/v1/core/storage/%%'')',
      rec.tbl, rec.col, rec.col, rec.col, rec.col, rec.col
    );
  END LOOP;
END $$;
