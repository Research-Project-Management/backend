-- =============================================================================
-- FLUX RESEARCH LIBRARY - DATA QUALITY & INVENTORY AUDIT QUERIES (READ-ONLY)
-- Specification: Feature 002 Library Contract and Data Cleanup (Task T001/T003)
-- Scope: Read-only diagnostics for schema debt, duplication, and integrity
-- =============================================================================

-- 1. Table Row Counts Across All Library Related Tables
SELECT 'papers (CatalogItem)' AS table_name, COUNT(*)::bigint AS row_count FROM "papers"
UNION ALL
SELECT 'catalog_contributors (ItemContributor)', COUNT(*)::bigint FROM "catalog_contributors"
UNION ALL
SELECT 'catalog_identifiers (ItemIdentifier)', COUNT(*)::bigint FROM "catalog_identifiers"
UNION ALL
SELECT 'collections (Collection)', COUNT(*)::bigint FROM "collections"
UNION ALL
SELECT 'collection_items (CollectionMembership)', COUNT(*)::bigint FROM "collection_items"
UNION ALL
SELECT 'catalog_tags (Tag)', COUNT(*)::bigint FROM "catalog_tags"
UNION ALL
SELECT 'catalog_item_tags (ItemTag)', COUNT(*)::bigint FROM "catalog_item_tags"
UNION ALL
SELECT 'paper_attachments (CatalogAttachment)', COUNT(*)::bigint FROM "paper_attachments"
UNION ALL
SELECT 'attachment_revisions (AttachmentRevision)', COUNT(*)::bigint FROM "attachment_revisions"
UNION ALL
SELECT 'annotations (Annotation)', COUNT(*)::bigint FROM "annotations"
UNION ALL
SELECT 'notes (Note)', COUNT(*)::bigint FROM "notes"
UNION ALL
SELECT 'item_relations (ItemRelation)', COUNT(*)::bigint FROM "item_relations"
UNION ALL
SELECT 'ingestion_runs (IngestionRun)', COUNT(*)::bigint FROM "ingestion_runs"
UNION ALL
SELECT 'ingestion_stages (IngestionStage)', COUNT(*)::bigint FROM "ingestion_stages"
UNION ALL
SELECT 'ingestion_candidates (IngestionCandidate)', COUNT(*)::bigint FROM "ingestion_candidates"
UNION ALL
SELECT 'ingestion_decisions (IngestionDecision)', COUNT(*)::bigint FROM "ingestion_decisions"
UNION ALL
SELECT 'ingestion_review_cases (IngestionReviewCase)', COUNT(*)::bigint FROM "ingestion_review_cases"
UNION ALL
SELECT 'sync_sequences (SyncSequence)', COUNT(*)::bigint FROM "sync_sequences"
UNION ALL
SELECT 'library_changes (LibraryChange)', COUNT(*)::bigint FROM "library_changes"
UNION ALL
SELECT 'tombstones (Tombstone)', COUNT(*)::bigint FROM "tombstones"
UNION ALL
SELECT 'user_item_states (UserItemState)', COUNT(*)::bigint FROM "user_item_states"
UNION ALL
SELECT 'outbox_events (OutboxEvent)', COUNT(*)::bigint FROM "outbox_events"
UNION ALL
SELECT 'idempotency_records (IdempotencyRecord)', COUNT(*)::bigint FROM "idempotency_records"
UNION ALL
SELECT 'library_dedup_claims (LibraryDedupClaim)', COUNT(*)::bigint FROM "library_dedup_claims"
UNION ALL
SELECT 'saved_searches (SavedSearch)', COUNT(*)::bigint FROM "saved_searches"
UNION ALL
SELECT 'full_text_indexes (FullTextIndex)', COUNT(*)::bigint FROM "full_text_indexes"
UNION ALL
SELECT 'duplicate_clusters (DuplicateCluster)', COUNT(*)::bigint FROM "duplicate_clusters"
UNION ALL
SELECT 'capture_previews (CapturePreview)', COUNT(*)::bigint FROM "capture_previews"
ORDER BY row_count DESC;

-- 2. Null vs Empty String Distribution on CatalogItem ('papers')
SELECT 
    'doi' AS column_name,
    COUNT(*) FILTER (WHERE doi IS NULL) AS null_count,
    COUNT(*) FILTER (WHERE doi = '') AS empty_string_count,
    COUNT(*) FILTER (WHERE doi IS NOT NULL AND doi != '') AS populated_count
FROM "papers"
UNION ALL
SELECT 
    'abstract',
    COUNT(*) FILTER (WHERE abstract IS NULL),
    COUNT(*) FILTER (WHERE abstract = ''),
    COUNT(*) FILTER (WHERE abstract IS NOT NULL AND abstract != '')
FROM "papers"
UNION ALL
SELECT 
    'journal',
    COUNT(*) FILTER (WHERE journal IS NULL),
    COUNT(*) FILTER (WHERE journal = ''),
    COUNT(*) FILTER (WHERE journal IS NOT NULL AND journal != '')
FROM "papers"
UNION ALL
SELECT 
    'publication_title',
    COUNT(*) FILTER (WHERE publication_title IS NULL),
    COUNT(*) FILTER (WHERE publication_title = ''),
    COUNT(*) FILTER (WHERE publication_title IS NOT NULL AND publication_title != '')
FROM "papers"
UNION ALL
SELECT 
    'publisher',
    COUNT(*) FILTER (WHERE publisher IS NULL),
    COUNT(*) FILTER (WHERE publisher = ''),
    COUNT(*) FILTER (WHERE publisher IS NOT NULL AND publisher != '')
FROM "papers"
UNION ALL
SELECT 
    'file_url',
    COUNT(*) FILTER (WHERE file_url IS NULL),
    COUNT(*) FILTER (WHERE file_url = ''),
    COUNT(*) FILTER (WHERE file_url IS NOT NULL AND file_url != '')
FROM "papers"
UNION ALL
SELECT 
    'filename',
    COUNT(*) FILTER (WHERE filename IS NULL),
    COUNT(*) FILTER (WHERE filename = ''),
    COUNT(*) FILTER (WHERE filename IS NOT NULL AND filename != '')
FROM "papers";

-- 3. String Literal 'undefined' and 'null' Anomalies
SELECT 
    id,
    workspace_id,
    title,
    doi,
    abstract,
    publication_title,
    file_url
FROM "papers"
WHERE 
    lower(doi) IN ('undefined', 'null', '[undefined]', '[null]')
    OR lower(title) IN ('undefined', 'null', '[undefined]', '[null]')
    OR lower(abstract) IN ('undefined', 'null')
    OR lower(publication_title) IN ('undefined', 'null')
    OR lower(file_url) IN ('undefined', 'null')
    OR lower(filename) IN ('undefined', 'null');

-- 4. Authors Array Column vs Normalized catalog_contributors Table
SELECT 
    p.id AS catalog_item_id,
    p.workspace_id,
    cardinality(p.authors) AS author_array_len,
    COUNT(c.id) AS contributor_row_count
FROM "papers" p
LEFT JOIN "catalog_contributors" c ON c.catalog_item_id = p.id
WHERE cardinality(p.authors) > 0
GROUP BY p.id, p.workspace_id, p.authors
HAVING cardinality(p.authors) != COUNT(c.id);

-- 5. Identifier Columns vs Normalized catalog_identifiers Table
SELECT 
    p.id AS catalog_item_id,
    p.workspace_id,
    p.doi,
    p.isbn,
    p.pmid,
    COUNT(ci.id) AS identifier_row_count
FROM "papers" p
LEFT JOIN "catalog_identifiers" ci ON ci.catalog_item_id = p.id
WHERE (p.doi IS NOT NULL AND p.doi != '')
   OR (p.isbn IS NOT NULL AND p.isbn != '')
   OR (p.pmid IS NOT NULL AND p.pmid != '')
GROUP BY p.id, p.workspace_id, p.doi, p.isbn, p.pmid
HAVING COUNT(ci.id) = 0;

-- 6. Collection Column vs collection_items Membership Table
SELECT 
    p.id AS catalog_item_id,
    p.workspace_id,
    p.collection_id,
    COUNT(ci.id) AS membership_count
FROM "papers" p
LEFT JOIN "collection_items" ci ON ci.catalog_item_id = p.id AND ci.collection_id = p.collection_id
WHERE p.collection_id IS NOT NULL
GROUP BY p.id, p.workspace_id, p.collection_id
HAVING COUNT(ci.id) = 0;

-- 7. Tags / Labels Array vs catalog_item_tags Table
SELECT 
    p.id AS catalog_item_id,
    p.workspace_id,
    cardinality(p.labels) AS labels_count,
    cardinality(p.keywords) AS keywords_count,
    COUNT(cit.id) AS item_tag_count
FROM "papers" p
LEFT JOIN "catalog_item_tags" cit ON cit.catalog_item_id = p.id
WHERE cardinality(p.labels) > 0 OR cardinality(p.keywords) > 0
GROUP BY p.id, p.workspace_id, p.labels, p.keywords
HAVING COUNT(cit.id) = 0;

-- 8. File URL / Primary File Column vs paper_attachments Table
SELECT 
    p.id AS catalog_item_id,
    p.workspace_id,
    p.file_url,
    p.filename,
    COUNT(a.id) AS attachment_count
FROM "papers" p
LEFT JOIN "paper_attachments" a ON a."paperId" = p.id
WHERE p.file_url IS NOT NULL AND p.file_url != ''
GROUP BY p.id, p.workspace_id, p.file_url, p.filename
HAVING COUNT(a.id) = 0;

-- 9. Malformed or Non-Empty JSON in extra and notes
SELECT 
    id,
    workspace_id,
    extra,
    notes
FROM "papers"
WHERE (extra IS NOT NULL AND extra != '' AND extra != '{}')
   OR (notes IS NOT NULL AND notes::text != '[]' AND notes::text != '');

-- 10. Orphan Relations Check
SELECT 
    r.id,
    r.workspace_id,
    r.source_item_id,
    r.target_item_id,
    r.relation_type
FROM "item_relations" r
WHERE NOT EXISTS (SELECT 1 FROM "papers" p WHERE p.id = r.source_item_id)
   OR NOT EXISTS (SELECT 1 FROM "papers" p WHERE p.id = r.target_item_id);

-- 11. Duplicate Active DOIs in Same Workspace
SELECT 
    workspace_id,
    doi,
    COUNT(*) AS duplicate_count
FROM "papers"
WHERE doi IS NOT NULL AND doi != '' AND deleted_at IS NULL
GROUP BY workspace_id, doi
HAVING COUNT(*) > 1;

-- 12. Rating Boundary Check (Must be 1..5)
SELECT 
    id,
    user_id,
    item_id,
    rating
FROM "user_item_states"
WHERE rating IS NOT NULL AND (rating < 0 OR rating > 5);

-- 13. Missing Workspace Scope Validation
SELECT 'papers' AS entity, COUNT(*) AS missing_workspace_count FROM "papers" WHERE workspace_id IS NULL
UNION ALL
SELECT 'collections', COUNT(*) FROM "collections" WHERE workspace_id IS NULL
UNION ALL
SELECT 'notes', COUNT(*) FROM "notes" WHERE workspace_id IS NULL
UNION ALL
SELECT 'item_relations', COUNT(*) FROM "item_relations" WHERE workspace_id IS NULL
UNION ALL
SELECT 'catalog_tags', COUNT(*) FROM "catalog_tags" WHERE workspace_id IS NULL;

-- 14. Active Dedup Claims for Soft-Deleted Items
SELECT 
    c.id AS claim_id,
    c.workspace_id,
    c.claim_type,
    c.claim_value,
    p.id AS catalog_item_id,
    p.deleted_at
FROM "library_dedup_claims" c
JOIN "papers" p ON c.catalog_item_id = p.id
WHERE p.deleted_at IS NOT NULL;
