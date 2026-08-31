-- =============================================================================
-- Migration: 20260901000000_library_data_convergence_phase3
-- Purpose: Additive convergence schema changes for Merge Lineage and Lineage tracking
-- Mode: Strictly Additive (Zero Drops)
-- =============================================================================

-- 1. Create catalog_merge_lineage table if not exists
CREATE TABLE IF NOT EXISTS "catalog_merge_lineage" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_item_id" TEXT NOT NULL,
    "target_item_id" TEXT NOT NULL,
    "merge_reason" TEXT DEFAULT 'manual',
    "merged_fields" JSONB,
    "merged_by_id" TEXT,
    "merged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_merge_lineage_pkey" PRIMARY KEY ("id")
);

-- 2. Create performance and lookup indexes
CREATE INDEX IF NOT EXISTS "catalog_merge_lineage_workspace_id_source_item_id_idx" ON "catalog_merge_lineage"("workspace_id", "source_item_id");
CREATE INDEX IF NOT EXISTS "catalog_merge_lineage_target_item_id_idx" ON "catalog_merge_lineage"("target_item_id");

-- 3. Add foreign key constraints safely
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'catalog_merge_lineage_workspace_id_fkey'
    ) THEN
        ALTER TABLE "catalog_merge_lineage" 
        ADD CONSTRAINT "catalog_merge_lineage_workspace_id_fkey" 
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'catalog_merge_lineage_target_item_id_fkey'
    ) THEN
        ALTER TABLE "catalog_merge_lineage" 
        ADD CONSTRAINT "catalog_merge_lineage_target_item_id_fkey" 
        FOREIGN KEY ("target_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
