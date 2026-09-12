-- ============================================================
-- Migration: IAM Personal Workspace v2
-- Date: 2026-09-12
-- Description:
--   1. Enforce 1-to-1 between User and Workspace via owner_id
--   2. Rename project role 'admin' to 'owner'
--   3. Remove workspace-level role from workspace_invitations
-- ============================================================

-- Step 1: Add owner_id column to workspaces
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Step 2: Backfill owner_id = created_by_id for all existing workspaces
UPDATE workspaces
SET owner_id = created_by_id
WHERE owner_id IS NULL
  AND created_by_id IS NOT NULL;

-- Step 3: Deduplicate and add unique constraint
DO $$
BEGIN
  DELETE FROM workspaces w1
  USING workspaces w2
  WHERE w1.owner_id = w2.owner_id
    AND w1.created_at < w2.created_at;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_owner_id_key'
  ) THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_id_key UNIQUE (owner_id);
  END IF;
END $$;

-- Step 4: Add 'owner' value to ProjectMemberRole enum
ALTER TYPE "ProjectMemberRole" ADD VALUE IF NOT EXISTS 'owner';

-- Step 5: Rename project role admin -> owner
UPDATE project_members SET role = 'owner' WHERE role = 'admin';

-- Step 6: Remove role column from workspace_invitations
ALTER TABLE workspace_invitations DROP COLUMN IF EXISTS role;

-- Step 7: Index for fast personal workspace lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspaces_owner_id_idx ON workspaces(owner_id);
