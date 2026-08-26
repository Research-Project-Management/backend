-- ==============================================================================
-- FLUX LIBRARY: Collection Membership Canonical Backfill & Reconciliation
-- Task: T024
-- Source: papers.collection_id -> Destination: collection_items
-- ==============================================================================

-- ── 1. PRE-CHECK & DRY-RUN RECONCILIATION ────────────────────────────────────
-- Count legacy collection assignments eligible for migration
SELECT 
  COUNT(*) AS legacy_eligible_count,
  COUNT(DISTINCT p.id) AS unique_papers_count,
  COUNT(DISTINCT p.collection_id) AS distinct_collections_count
FROM papers p
WHERE p.collection_id IS NOT NULL
  AND p.deleted_at IS NULL;

-- ── 2. IDEMPOTENT BACKFILL EXECUTION ─────────────────────────────────────────
-- Inserts missing rows into collection_items without overwriting existing memberships
INSERT INTO collection_items (
  id,
  collection_id,
  catalog_item_id,
  sort_order,
  added_at
)
SELECT 
  gen_random_uuid(),
  p.collection_id,
  p.id,
  0,
  COALESCE(p.created_at, NOW())
FROM papers p
WHERE p.collection_id IS NOT NULL
  AND p.deleted_at IS NULL
ON CONFLICT (collection_id, catalog_item_id) DO NOTHING;

-- ── 3. POST-MIGRATION RECONCILIATION PARITY AUDIT ────────────────────────────
-- Validates 100% parity between legacy assignments and canonical memberships
WITH missing_canonical AS (
  SELECT 
    p.id AS catalog_item_id,
    p.collection_id,
    p.workspace_id
  FROM papers p
  LEFT JOIN collection_items ci 
    ON ci.catalog_item_id = p.id 
   AND ci.collection_id = p.collection_id
  WHERE p.collection_id IS NOT NULL
    AND p.deleted_at IS NULL
    AND ci.id IS NULL
)
SELECT 
  COUNT(*) AS missing_parity_discrepancy_count
FROM missing_canonical;

-- ── 4. ROLLBACK SCRIPT (IF NEEDED) ───────────────────────────────────────────
-- Deletes canonical memberships that match active legacy collection_id
-- DELETE FROM collection_items ci
-- USING papers p
-- WHERE ci.catalog_item_id = p.id
--   AND ci.collection_id = p.collection_id
--   AND p.collection_id IS NOT NULL;
