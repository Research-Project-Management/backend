-- ==============================================================================
-- MIGRATION: 20260902000000_library_destructive_contraction
-- SPECIFICATION: specs/002-library-contract-data-cleanup/spec.md (Task T053)
-- DESCRIPTION: Destructive schema contraction dropping backfilled compatibility columns.
-- ==============================================================================

-- 1. Pre-Execution Assertion Verification (actual PostgreSQL table/column names)
DO $$
BEGIN
  -- Verify catalog_contributors backfill parity
  IF EXISTS (
    SELECT 1 FROM papers p
    WHERE cardinality(p.authors) > 0
      AND NOT EXISTS (
        SELECT 1 FROM catalog_contributors cc
        WHERE cc.catalog_item_id = p.id AND cc.creator_type = 'author'
      )
  ) THEN
    RAISE EXCEPTION 'Pre-migration check failed: un-backfilled authors found in papers';
  END IF;

  -- Verify collection_items membership backfill parity
  IF EXISTS (
    SELECT 1 FROM papers p
    WHERE p.collection_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM collection_items ci
        WHERE ci.catalog_item_id = p.id AND ci.collection_id = p.collection_id
      )
  ) THEN
    RAISE EXCEPTION 'Pre-migration check failed: un-backfilled collection_id found in papers';
  END IF;
END $$;

-- 2. Drop Compatibility Foreign Key Constraint
ALTER TABLE papers DROP CONSTRAINT IF EXISTS papers_collection_id_fkey;

-- 3. Drop Backfilled Compatibility Columns
ALTER TABLE papers
  DROP COLUMN IF EXISTS authors,
  DROP COLUMN IF EXISTS editors,
  DROP COLUMN IF EXISTS keywords,
  DROP COLUMN IF EXISTS labels,
  DROP COLUMN IF EXISTS collection_id,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS journal,
  DROP COLUMN IF EXISTS primary_file,
  DROP COLUMN IF EXISTS file_url,
  DROP COLUMN IF EXISTS filename,
  DROP COLUMN IF EXISTS mime_type,
  DROP COLUMN IF EXISTS size;

-- ==============================================================================
-- ROLLBACK SCRIPT:
-- ALTER TABLE papers ADD COLUMN authors TEXT[] DEFAULT '{}';
-- ALTER TABLE papers ADD COLUMN editors TEXT[] DEFAULT '{}';
-- ALTER TABLE papers ADD COLUMN keywords TEXT[] DEFAULT '{}';
-- ALTER TABLE papers ADD COLUMN labels TEXT[] DEFAULT '{}';
-- ALTER TABLE papers ADD COLUMN collection_id TEXT;
-- ALTER TABLE papers ADD COLUMN notes JSONB DEFAULT '[]';
-- ALTER TABLE papers ADD COLUMN journal TEXT DEFAULT '';
-- ALTER TABLE papers ADD COLUMN primary_file JSONB;
-- ALTER TABLE papers ADD COLUMN file_url TEXT DEFAULT '';
-- ALTER TABLE papers ADD COLUMN filename TEXT DEFAULT '';
-- ALTER TABLE papers ADD COLUMN mime_type TEXT DEFAULT 'application/pdf';
-- ALTER TABLE papers ADD COLUMN size INTEGER DEFAULT 0;
-- ALTER TABLE papers ADD CONSTRAINT papers_collection_id_fkey
--   FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL;
-- ==============================================================================
