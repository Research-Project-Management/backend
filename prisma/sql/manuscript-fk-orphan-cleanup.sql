-- ============================================================================
-- Manuscript FK orphan cleanup
-- Run BEFORE `prisma db push` introduces the new project/doc foreign keys,
-- otherwise the constraint creation fails on existing orphan rows.
--
-- Usage:  psql "$DATABASE_URL" -f backend/prisma/sql/manuscript-fk-orphan-cleanup.sql
-- Step 1 reports counts (read-only). Step 2 deletes inside one transaction.
-- ============================================================================

-- Step 1: dry-run report
SELECT 'manuscript_docs' AS tbl, count(*) AS orphans FROM manuscript_docs d
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = d.project_id)
UNION ALL SELECT 'manuscript_nodes', count(*) FROM manuscript_nodes n
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = n.project_id)
UNION ALL SELECT 'manuscript_files', count(*) FROM manuscript_files f
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = f.project_id)
UNION ALL SELECT 'manuscript_snapshots', count(*) FROM manuscript_snapshots s
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id)
UNION ALL SELECT 'manuscript_labels', count(*) FROM manuscript_labels l
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id)
UNION ALL SELECT 'manuscript_track_changes (project)', count(*) FROM manuscript_track_changes t
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id)
UNION ALL SELECT 'manuscript_track_changes (doc)', count(*) FROM manuscript_track_changes t
  WHERE NOT EXISTS (SELECT 1 FROM manuscript_docs d WHERE d.id = t.doc_id)
UNION ALL SELECT 'manuscript_comment_threads (project)', count(*) FROM manuscript_comment_threads c
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id)
UNION ALL SELECT 'manuscript_comment_threads (doc)', count(*) FROM manuscript_comment_threads c
  WHERE NOT EXISTS (SELECT 1 FROM manuscript_docs d WHERE d.id = c.doc_id)
UNION ALL SELECT 'manuscript_custom_words', count(*) FROM manuscript_custom_words w
  WHERE w.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id)
UNION ALL SELECT 'manuscript_notifications (project)', count(*) FROM manuscript_notifications n
  WHERE n.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = n.project_id)
UNION ALL SELECT 'manuscript_notifications (doc, will be NULLed)', count(*) FROM manuscript_notifications n
  WHERE n.doc_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM manuscript_docs d WHERE d.id = n.doc_id);

-- Step 2: cleanup (children first)
BEGIN;

DELETE FROM manuscript_nodes n
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = n.project_id);
DELETE FROM manuscript_track_changes t
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id)
     OR NOT EXISTS (SELECT 1 FROM manuscript_docs d WHERE d.id = t.doc_id);
DELETE FROM manuscript_comment_threads c   -- replies cascade via fk_comment_replies_thread_id
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id)
     OR NOT EXISTS (SELECT 1 FROM manuscript_docs d WHERE d.id = c.doc_id);
DELETE FROM manuscript_labels l
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id);
DELETE FROM manuscript_snapshots s
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id);
DELETE FROM manuscript_files f
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = f.project_id);
DELETE FROM manuscript_custom_words w
  WHERE w.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id);
DELETE FROM manuscript_notifications n
  WHERE n.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = n.project_id);
UPDATE manuscript_notifications n SET doc_id = NULL
  WHERE n.doc_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM manuscript_docs d WHERE d.id = n.doc_id);
DELETE FROM manuscript_docs d
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = d.project_id);

COMMIT;
