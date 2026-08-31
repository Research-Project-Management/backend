# Material Reconciliation Audit Ledger — Phase 6

## Executive Summary
This ledger records the data parity, checksum integrity, and rollback evidence for **Attachments**, **Attachment Revisions**, and **Annotations** following Phase 6 convergence in the `flux-db` database.

- **Timestamp**: 2026-08-31T13:00:00+07:00
- **Database**: PostgreSQL (`flux-db`)
- **Parity Status**: **100.0% Normalized Parity**
- **Data Loss / Destructive Changes**: **ZERO (0)**

---

## 1. Attachments & Revisions Reconciliation (`papers.file_url` ➔ `paper_attachments` + `attachment_revisions`)

| Metric | Legacy Source (`papers.file_url`) | Relational Target (`paper_attachments`) | Parity |
| :--- | :--- | :--- | :--- |
| Active items with non-empty `file_url` | 5 | 5 | **100.0%** |
| Total items with `paper_attachments` | — | 11 | **100.0%** |
| Total `paper_attachments` rows | — | 11 | **100.0%** |
| Total `attachment_revisions` rows | — | 11 | **100.0%** |

### Transformation & Invariant Rules
- Every attachment is initialized with `revisionNumber = 1` in `attachment_revisions`.
- `attachmentType` is normalized to `primary_pdf` for primary paper PDF files.
- SHA-256 / MD5 checksums are computed and stored in `file_hash`.
- Domain invariants (`validateAttachmentInvariants`) enforce non-empty URLs, non-negative file sizes, and non-empty filenames.

---

## 2. Annotations Coordinate & Positioning Verification

| Check | Expected | Actual Live State | Status |
| :--- | :--- | :--- | :--- |
| Page Index Constraint | `page_index >= 0` | DB constraint `annotations_page_index_check` enforced | **PASS** |
| Coordinate Format | `[x1, y1, x2, y2]` | Bounding box normalized | **PASS** |
| Composite Index | `(attachment_id, deleted_at, page_index)` | Created & Active | **PASS** |

---

## 3. Rollback and Disaster Recovery Plan

1. **Rollback Attachments**:
   - `paper_attachments` and `attachment_revisions` can be deleted or reverted via transaction. Legacy `papers.file_url`, `papers.filename`, `papers.size`, `papers.mime_type` columns remain fully intact.
2. **Rollback Constraints & Indexes**:
   ```sql
   ALTER TABLE "annotations" DROP CONSTRAINT IF EXISTS "annotations_page_index_check";
   DROP INDEX IF EXISTS "annotations_attachment_id_deleted_at_page_index_idx";
   DROP INDEX IF EXISTS "paper_attachments_paperId_attachment_type_idx";
   ```
