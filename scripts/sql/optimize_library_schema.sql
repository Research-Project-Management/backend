-- ============================================================================
-- FLUX LIBRARY DATABASE: ENTERPRISE OPTIMIZATION & HARDENING SCRIPT
-- PostgreSQL 15+ / 16+ Production Tuning
--
-- This script applies database-level optimizations beyond Prisma schema syntax:
-- 1. Trigram Full-Text GIN Index on full_text_indexes (Eliminates Seq Scan)
-- 2. Business Integrity CHECK Constraints
-- 3. Partial B-Tree Indexes on Active Records (WHERE deleted_at IS NULL)
-- 4. TTL / Outbox Maintenance Stored Procedure
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Full-Text Search Optimization (attachments / full_text_indexes)
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN index for ultra-fast ILIKE '%term%' text queries across paper pages
CREATE INDEX IF NOT EXISTS idx_full_text_indexes_trgm 
  ON full_text_indexes 
  USING gin (text_content gin_trgm_ops);

-- English Language TSVector GIN index for stem-based lexical ranking
CREATE INDEX IF NOT EXISTS idx_full_text_indexes_tsv 
  ON full_text_indexes 
  USING gin (to_tsvector('english', text_content));


-- ----------------------------------------------------------------------------
-- 2. Business Integrity CHECK Constraints
-- ----------------------------------------------------------------------------

-- State rating must be between 0 and 5 stars (or NULL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_state_rating_range'
  ) THEN
    ALTER TABLE user_item_states 
      ADD CONSTRAINT chk_state_rating_range 
      CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5));
  END IF;
END $$;

-- Item counter caches cannot be negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_item_counts_non_negative'
  ) THEN
    ALTER TABLE items 
      ADD CONSTRAINT chk_item_counts_non_negative 
      CHECK (attachment_count >= 0 AND note_count >= 0);
  END IF;
END $$;

-- IngestionRun attempts and retries cannot be negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ingestion_attempts_non_negative'
  ) THEN
    ALTER TABLE ingestion_runs 
      ADD CONSTRAINT chk_ingestion_attempts_non_negative 
      CHECK (attempts >= 0 AND max_retries >= 0);
  END IF;
END $$;

-- Contributor orderIndex cannot be negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_contributor_order_non_negative'
  ) THEN
    ALTER TABLE contributors 
      ADD CONSTRAINT chk_contributor_order_non_negative 
      CHECK (order_index >= 0);
  END IF;
END $$;

-- AttachmentRevision revisionNumber must be >= 1
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_revision_number_positive'
  ) THEN
    ALTER TABLE attachment_revisions 
      ADD CONSTRAINT chk_revision_number_positive 
      CHECK (revision_number >= 1);
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 3. Partial B-Tree Indexes on Active Records (WHERE deleted_at IS NULL)
-- Eliminates index bloat from soft-deleted tombstones; keeps hot working set in RAM
-- ----------------------------------------------------------------------------

-- Fast user items list ordering by year and creation date (Active only)
CREATE INDEX IF NOT EXISTS idx_items_active_user_year 
  ON items (user_id, year DESC, created_at DESC) 
  WHERE deleted_at IS NULL;

-- Fast project items list ordering (Active only)
CREATE INDEX IF NOT EXISTS idx_items_active_project 
  ON items (project_id, created_at DESC) 
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;

-- Fast user notes list ordering by updated date (Active only)
CREATE INDEX IF NOT EXISTS idx_notes_active_user_updated 
  ON notes (user_id, updated_at DESC) 
  WHERE deleted_at IS NULL;

-- Fast collection tree traversal (Active only)
CREATE INDEX IF NOT EXISTS idx_collections_active_hierarchy 
  ON collections (user_id, parent_id, sort_order) 
  WHERE deleted_at IS NULL;

-- Fast active attachments per item
CREATE INDEX IF NOT EXISTS idx_attachments_active_item 
  ON attachments (item_id, attachment_type) 
  WHERE deleted_at IS NULL;

-- Fast active annotations per attachment and page
CREATE INDEX IF NOT EXISTS idx_annotations_active_page 
  ON annotations (attachment_id, page_index, annotation_sort_index) 
  WHERE deleted_at IS NULL;


-- ----------------------------------------------------------------------------
-- 4. Unprocessed / In-Flight Outbox Event Partial Index
-- Indexes ONLY pending or processing outbox events (ignoring millions of published rows)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_outbox_events_unprocessed 
  ON outbox_events (scheduled_at, lease_expires_at) 
  WHERE status IN ('PENDING', 'PROCESSING');


-- ----------------------------------------------------------------------------
-- 5. Maintenance / Retention Cleanup Procedure
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE prune_library_expired_data(
  retention_outbox_days INT DEFAULT 14,
  retention_idempotency_hours INT DEFAULT 24
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_outbox INT;
  v_deleted_idempotency INT;
BEGIN
  -- Prune published outbox events older than retention period
  DELETE FROM outbox_events 
  WHERE status = 'PUBLISHED' 
    AND processed_at < (NOW() - (retention_outbox_days || ' days')::INTERVAL);
  GET DIAGNOSTICS v_deleted_outbox = ROW_COUNT;

  -- Prune expired idempotency records
  DELETE FROM idempotency_records 
  WHERE expires_at < NOW();
  GET DIAGNOSTICS v_deleted_idempotency = ROW_COUNT;

  RAISE NOTICE 'Pruning completed: % outbox events, % idempotency records removed.', 
    v_deleted_outbox, v_deleted_idempotency;
END;
$$;
