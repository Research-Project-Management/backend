-- =============================================================================
-- Migration: 20260901000002_library_attachments_annotations_phase6
-- Purpose: Additive constraints & indexes for Attachments & Annotations positioning
-- Mode: Strictly Additive (Zero Drops)
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'annotations_page_index_check'
    ) THEN
        ALTER TABLE "annotations" 
        ADD CONSTRAINT "annotations_page_index_check" 
        CHECK ("page_index" >= 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "annotations_attachment_id_deleted_at_page_index_idx" 
ON "annotations" ("attachment_id", "deleted_at", "page_index");

CREATE INDEX IF NOT EXISTS "paper_attachments_paperId_attachment_type_idx" 
ON "paper_attachments" ("paperId", "attachment_type");
