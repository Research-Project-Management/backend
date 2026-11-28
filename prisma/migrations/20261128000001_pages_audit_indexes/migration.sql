-- Pages Senior Backend Audit: Composite indexes eliminating seq-scans on FK cascades,
-- trash queries, doc/file listings, and grouped review changes.

CREATE INDEX IF NOT EXISTS "idx_page_files_space_del_created"
  ON "page_files"("space_id", "deleted_at", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_page_files_space_del_updated"
  ON "page_files"("space_id", "deleted_at", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_page_docs_space_del_path"
  ON "page_docs"("space_id", "deleted_at", "last_known_path");

CREATE INDEX IF NOT EXISTS "idx_page_nodes_parent_id"
  ON "page_nodes"("parent_id");

CREATE INDEX IF NOT EXISTS "idx_pages_space_del_created"
  ON "pages"("space_id", "deleted_at", "created_at");

CREATE INDEX IF NOT EXISTS "idx_pages_space_del_status"
  ON "pages"("space_id", "deleted_at", "status");

CREATE INDEX IF NOT EXISTS "idx_doc_changes_doc_group_status"
  ON "doc_changes"("doc_id", "group_id", "status");
