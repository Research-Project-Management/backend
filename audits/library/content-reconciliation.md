# Content Reconciliation Audit Ledger — Phase 5

## Executive Summary
This ledger records the data parity, transformation verification, and rollback evidence for **Tags**, **Notes**, and **Reading States** following Phase 5 convergence in the `flux-db` database.

- **Timestamp**: 2026-08-31T12:33:28+07:00
- **Database**: PostgreSQL (`flux-db`)
- **Parity Status**: **100.0% Normalized Parity**
- **Data Loss / Destructive Changes**: **ZERO (0)**

---

## 1. Item Tags Reconciliation (`papers.labels/keywords` ➔ `catalog_tags` + `catalog_item_tags`)

| Metric | Legacy Source (`papers.labels/keywords`) | Relational Target (`catalog_item_tags`) | Parity |
| :--- | :--- | :--- | :--- |
| Active items with non-empty labels/keywords | 0 | 0 | **100.0%** |
| Total `catalog_tags` rows | — | 0 | **100.0%** |
| Total `catalog_item_tags` rows | — | 0 | **100.0%** |

### Transformation Rules
- Tag normalization trims whitespace, strips leading `#`, and collapses duplicate spaces.
- Unique constraint `(workspace_id, name)` on `catalog_tags` ensures workspace isolation.
- Unique constraint `(tag_id, catalog_item_id)` on `catalog_item_tags` prevents duplicate linkages.

---

## 2. Item Notes Reconciliation (`papers.notes` ➔ `notes`)

| Metric | Legacy Source (`papers.notes`) | Relational Target (`notes`) | Parity |
| :--- | :--- | :--- | :--- |
| Active items with valid legacy notes | 1 (`a9e13dee-719e-4d4e-b22f-11f9ae602621`) | 1 (`a9e13dee-719e-4d4e-b22f-11f9ae602621`) | **100.0%** |
| Total `notes` rows created | — | 1 | **100.0%** |
| Note titles generated | — | `["Note 1"]` | **100.0%** |

### Transformation Rules
- String arrays in `papers.notes` are decomposed into individual `Note` records linked to `item_id` and `workspace_id`.
- Note content markdown (`content_md`) and JSON document structures (`content_json`) are preserved.
- `created_by_id` is attributed to `uploaded_by_id` or workspace owner.

---

## 3. Reading Rating Constraint Verification (`user_item_states`)

| Check | Expected | Actual Live State | Status |
| :--- | :--- | :--- | :--- |
| Rating Range | `0 <= rating <= 5` or `NULL` | 1/1 state valid (rating=0) | **PASS** |
| DB Constraint Name | `user_item_states_rating_check` | `user_item_states_rating_check` | **ACTIVE** |
| DB Constraint SQL | `CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5))` | `CHECK (((rating IS NULL) OR ((rating >= 0) AND (rating <= 5))))` | **PASS** |

---

## 4. Rollback and Disaster Recovery Plan

1. **Rollback Tags**:
   - `catalog_tags` and `catalog_item_tags` can be cleared or selectively dropped via foreign key cascade if needed. Legacy `papers.labels` and `papers.keywords` columns remain intact.
2. **Rollback Notes**:
   - Notes backfilled with `item_id IS NOT NULL` can be identified and reverted. Legacy `papers.notes` column remains intact.
3. **Rollback Constraints**:
   ```sql
   ALTER TABLE "user_item_states" DROP CONSTRAINT IF EXISTS "user_item_states_rating_check";
   ```
