-- ============================================================================
-- Pages FK orphan cleanup (space_id -> spaces(id), page_docs(id))
-- Run carefully BEFORE FK constraints if legacy orphan rows exist.
--
-- Usage:  psql "$DATABASE_URL" -f backend/prisma/sql/manuscript-fk-orphan-cleanup.sql
-- Step 1 reports counts (read-only). Step 2 deletes inside one transaction.
-- ============================================================================

-- Step 1: dry-run report
SELECT 'page_docs' AS tbl, count(*) AS orphans FROM page_docs d
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = d.space_id)
UNION ALL SELECT 'page_nodes', count(*) FROM page_nodes n
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = n.space_id)
UNION ALL SELECT 'page_files', count(*) FROM page_files f
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = f.space_id)
UNION ALL SELECT 'page_snapshots', count(*) FROM page_snapshots sn
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = sn.space_id)
UNION ALL SELECT 'page_snapshot_labels', count(*) FROM page_snapshot_labels l
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = l.space_id)
UNION ALL SELECT 'page_track_changes (space)', count(*) FROM page_track_changes t
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = t.space_id)
UNION ALL SELECT 'page_track_changes (doc)', count(*) FROM page_track_changes t
  WHERE NOT EXISTS (SELECT 1 FROM page_docs d WHERE d.id = t.doc_id)
UNION ALL SELECT 'page_comment_threads (space)', count(*) FROM page_comment_threads c
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = c.space_id)
UNION ALL SELECT 'page_comment_threads (doc)', count(*) FROM page_comment_threads c
  WHERE NOT EXISTS (SELECT 1 FROM page_docs d WHERE d.id = c.doc_id)
UNION ALL SELECT 'custom_dictionary_words', count(*) FROM custom_dictionary_words w
  WHERE w.space_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = w.space_id)
UNION ALL SELECT 'page_notifications (space)', count(*) FROM page_notifications n
  WHERE n.space_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = n.space_id)
UNION ALL SELECT 'page_notifications (doc, will be NULLed)', count(*) FROM page_notifications n
  WHERE n.doc_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM page_docs d WHERE d.id = n.doc_id);

-- Step 2: cleanup (children first)
BEGIN;

DELETE FROM page_nodes n
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = n.space_id);
DELETE FROM page_track_changes t
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = t.space_id)
     OR NOT EXISTS (SELECT 1 FROM page_docs d WHERE d.id = t.doc_id);
DELETE FROM page_comment_threads c
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = c.space_id)
     OR NOT EXISTS (SELECT 1 FROM page_docs d WHERE d.id = c.doc_id);
DELETE FROM page_snapshot_labels l
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = l.space_id);
DELETE FROM page_snapshots sn
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = sn.space_id);
DELETE FROM page_files f
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = f.space_id);
DELETE FROM custom_dictionary_words w
  WHERE w.space_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = w.space_id);
DELETE FROM page_notifications n
  WHERE n.space_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = n.space_id);
UPDATE page_notifications n SET doc_id = NULL
  WHERE n.doc_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM page_docs d WHERE d.id = n.doc_id);
DELETE FROM page_docs d
  WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = d.space_id);

COMMIT;
