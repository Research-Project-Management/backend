# Data Quality & Database Invariant Audit Report

**Feature ID**: `002-library-contract-data-cleanup`  
**Execution Timestamp**: `2026-08-31T11:12:00Z`  
**Audit Target**: `flux-db` (PostgreSQL `public` schema)  
**Mode**: Read-Only Diagnostic Inspection (Zero Data Mutation)

---

## 1. Executive Summary

A comprehensive, non-destructive diagnostic query suite was executed against the active PostgreSQL database (`flux-db`) to quantify database debt, structural duality, missing backfills, and invariant anomalies across all 30 Library-related entities.

### Key Metrics:
- **Total Catalog Records (`papers`)**: 101 records (10 active, 91 soft-deleted).
- **Critical Duality & Backfill Gap**:
  - **Creators**: 85 papers store authors in `papers.authors` string array, while only **1** row exists in the normalized `catalog_contributors` table. 84 papers lack normalized contributor entries.
  - **Identifiers**: 23 papers store DOI in column `papers.doi`, but **0** rows exist in `catalog_identifiers`.
  - **Collections**: 4 papers reference `papers.collection_id`, but **0** rows exist in `collection_items` (membership table).
  - **Attachments**: 96 papers have non-empty `file_url`, but only **7** records exist in `paper_attachments`. 89 papers lack normalized attachment records.
  - **Notes**: 1 paper contains legacy JSON notes, while **0** records exist in the `notes` entity table.
- **Empty String (`""`) vs `NULL` Debt**:
  - `doi`: 46 `NULL`, 32 `""` (empty string), 23 populated valid DOI strings.
  - `publisher`: 8 `NULL`, 90 `""` (empty string), 3 populated strings.
  - `journal`: 0 `NULL`, 61 `""` (empty string), 40 populated strings.
  - `publication_title`: 1 `NULL`, 49 `""` (empty string), 51 populated strings.
  - `abstract`: 1 `NULL`, 17 `""` (empty string), 83 populated strings.
- **Deduplication Claim Integrity**:
  - **7** `library_dedup_claims` are linked to soft-deleted items (`papers.deleted_at IS NOT NULL`), creating potential conflicts for subsequent re-ingestion if soft-deleted claims are not purged or filtered by active status.
  - **1** duplicate DOI group detected in workspace `ws-test-e2e-fullstack` (`10.48550/arXiv.1706.03762` with count = 2).
- **Tenant Scope Isolation**:
  - **0** records missing `workspace_id` across `papers`, `collections`, `notes`, `item_relations`, `catalog_tags`. Tenant scoping is 100% compliant.

---

## 2. Model Row Counts & Inventory Ledger

| Table Name | Model Context | Total Rows | Active Rows | Soft-Deleted | Anomaly Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `papers` | CatalogItem | 101 | 10 | 91 | High legacy column duality |
| `catalog_contributors` | ItemContributor | 1 | 1 | 0 | Severe backfill deficit (84 missing) |
| `catalog_identifiers` | ItemIdentifier | 0 | 0 | 0 | Unpopulated (23 DOI in column) |
| `collections` | Collection | 6 | 6 | 0 | Healthy |
| `collection_items` | CollectionMembership | 0 | 0 | 0 | Unpopulated (4 col_id in column) |
| `catalog_tags` | Tag | 0 | 0 | 0 | Empty |
| `catalog_item_tags` | ItemTag | 0 | 0 | 0 | Empty |
| `paper_attachments` | CatalogAttachment | 7 | 7 | 0 | 89 papers have unmigrated fileUrl |
| `attachment_revisions` | AttachmentRevision | 7 | 7 | 0 | Matches attachments |
| `annotations` | Annotation | 0 | 0 | 0 | Empty |
| `notes` | Note | 0 | 0 | 0 | Empty (1 note in papers.notes JSON) |
| `item_relations` | ItemRelation | 0 | 0 | 0 | Empty |
| `ingestion_runs` | IngestionRun | 11 | 11 | 0 | Operational |
| `ingestion_stages` | IngestionStage | 0 | 0 | 0 | In-memory stage transitions |
| `ingestion_candidates`| IngestionCandidate | 0 | 0 | 0 | Transient in memory |
| `ingestion_decisions` | IngestionDecision | 0 | 0 | 0 | Transient in memory |
| `ingestion_review_cases`| IngestionReviewCase| 0 | 0 | 0 | No pending review cases |
| `sync_sequences` | SyncSequence | 2 | 2 | 0 | Operational |
| `library_changes` | LibraryChange | 11 | 11 | 0 | Monotonic event stream |
| `tombstones` | Tombstone | 0 | 0 | 0 | Clean |
| `user_item_states` | UserItemState | 1 | 1 | 0 | Operational |
| `outbox_events` | OutboxEvent | 6,145 | 6,145 | 0 | Operational outbox buffer |
| `idempotency_records` | IdempotencyRecord | 822 | 822 | 0 | High cache utilization |
| `library_dedup_claims`| LibraryDedupClaim | 8 | 8 | 0 | 7 claims on soft-deleted items |
| `saved_searches` | SavedSearch | 0 | 0 | 0 | Empty |
| `full_text_indexes` | FullTextIndex | 0 | 0 | 0 | Empty |
| `duplicate_clusters` | DuplicateCluster | 0 | 0 | 0 | Empty |
| `capture_previews` | CapturePreview | 4 | 4 | 0 | Operational URL previews |
| `zotero_connections` | ZoteroConnection | 0 | 0 | 0 | Ready |

---

## 3. Detailed Anomaly Analysis by Severity

### 🔴 Severity: HIGH (Data Duality & Missing Normalization)
1. **Author/Contributor Duality**:
   - `papers.authors` (PostgreSQL `text[]`) contains 85 records with author data (e.g. `{"Vaswani, Ashish", "Shazeer, Noam", ...}`).
   - Only 1 row exists in `catalog_contributors`.
   - *Risk*: Search or citation pipelines looking only at `catalog_contributors` will miss author information for 84 existing papers.
   - *Remediation Plan (Phase 3 T014)*: Additive migration backfill parsing `papers.authors` into ordered `catalog_contributors` with `order_index`.

2. **File URL vs Attachment Entity Duality**:
   - 96 papers have binary file locations in `papers.file_url`.
   - Only 7 records exist in `paper_attachments`.
   - *Risk*: Operations targeting `CatalogAttachment` directly (e.g. annotations, checksum validation, fulltext indexing) cannot link to the 89 legacy paper file URLs.
   - *Remediation Plan (Phase 6 T032)*: Backfill script to create `CatalogAttachment` records from `papers.file_url` + `papers.filename`.

3. **Collection Membership Duality**:
   - 4 papers have non-null `papers.collection_id`.
   - 0 records exist in `collection_items`.
   - *Risk*: Hierarchical playlist queries relying on `collection_items` will not see these 4 items.
   - *Remediation Plan (Phase 3 T016)*: Additive backfill from `papers.collection_id` into `collection_items`.

### 🟡 Severity: MEDIUM (Empty String vs NULL & Stale Claims)
1. **Empty String Defaults**:
   - `doi` has 32 records with `""` instead of `NULL`.
   - `journal` has 61 records with `""` instead of `NULL`.
   - `publisher` has 90 records with `""` instead of `NULL`.
   - *Risk*: SQL `IS NULL` filters fail to capture empty string representations, requiring awkward `WHERE col IS NULL OR col = ''`.
   - *Remediation Plan (Phase 3-6)*: Data cleanup migration updating `""` to `NULL` across all bibliographic fields.

2. **Deduplication Claims on Soft-Deleted Items**:
   - 7 rows in `library_dedup_claims` reference papers where `deleted_at IS NOT NULL`.
   - *Risk*: If a user deletes an item and re-ingests the same DOI, the unique constraint `[workspace_id, claim_type, claim_value]` may trigger a false positive conflict if not scoped or reconciled.
   - *Remediation Plan (Phase 3 T013)*: Clean up stale claims upon soft-delete or adjust claim lifecycle.

### 🟢 Severity: LOW / PASS (Workspace Isolation & Security)
1. **Tenant Isolation**:
   - 100% of rows across all library tables have valid, non-null `workspace_id`.
   - 0 orphan cross-tenant links.
2. **String Literal Anomaly**:
   - 0 occurrences of literal `"undefined"`, `"null"`, `"[undefined]"`, or `"[null]"` in `doi`, `title`, `abstract`, `publication_title`, `file_url`, `filename`.
3. **Rating Range**:
   - 100% of `user_item_states.rating` values fall within `[1, 5]` or `0/NULL`.

---

## 4. Execution Directives for Subsequent Phases

1. **Do NOT run destructive schema migrations**: No table, column, or constraint shall be dropped until Phase 10.
2. **Execute Expand-Backfill-Verify-Switch cycles**:
   - Phase 3: Expand/backfill `catalog_contributors` and `collection_items`.
   - Phase 5: Expand/backfill `catalog_tags` and `notes`.
   - Phase 6: Expand/backfill `paper_attachments` from `file_url`.
3. **Preserve Reversible Audit Snapshots**: Before executing any backfill, dump row hashes to verify zero data loss.
