-- CreateEnum
CREATE TYPE "IngestionStage" AS ENUM ('IDENTIFY', 'EXTRACT', 'NORMALIZE', 'ENRICH', 'RECONCILE', 'MATCH', 'COMMIT');

-- CreateEnum
CREATE TYPE "TagType" AS ENUM ('manual', 'automatic', 'ai');

-- AlterEnum
ALTER TYPE "AnnotationType" ADD VALUE 'ink';

-- AlterEnum
BEGIN;
CREATE TYPE "IngestionStatus_new" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED', 'STALLED');
ALTER TABLE "public"."ingestion_runs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ingestion_runs" ALTER COLUMN "status" TYPE "IngestionStatus_new" USING ("status"::text::"IngestionStatus_new");
ALTER TYPE "IngestionStatus" RENAME TO "IngestionStatus_old";
ALTER TYPE "IngestionStatus_new" RENAME TO "IngestionStatus";
DROP TYPE "public"."IngestionStatus_old";
ALTER TABLE "ingestion_runs" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_item_id_fkey";

-- DropForeignKey
ALTER TABLE "collection_items" DROP CONSTRAINT "collection_items_item_id_fkey";

-- DropForeignKey
ALTER TABLE "contributors" DROP CONSTRAINT "contributors_item_id_fkey";

-- DropForeignKey
ALTER TABLE "identifiers" DROP CONSTRAINT "identifiers_item_id_fkey";

-- DropForeignKey
ALTER TABLE "ingestion_candidates" DROP CONSTRAINT "ingestion_candidates_ingestion_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ingestion_decisions" DROP CONSTRAINT "ingestion_decisions_ingestion_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ingestion_review_cases" DROP CONSTRAINT "ingestion_review_cases_ingestion_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ingestion_runs" DROP CONSTRAINT "ingestion_runs_item_id_fkey";

-- DropForeignKey
ALTER TABLE "ingestion_stages" DROP CONSTRAINT "ingestion_stages_ingestion_run_id_fkey";

-- DropForeignKey
ALTER TABLE "item_relations" DROP CONSTRAINT "item_relations_source_item_id_fkey";

-- DropForeignKey
ALTER TABLE "item_relations" DROP CONSTRAINT "item_relations_target_item_id_fkey";

-- DropForeignKey
ALTER TABLE "item_revisions" DROP CONSTRAINT "item_revisions_item_id_fkey";

-- DropForeignKey
ALTER TABLE "item_tags" DROP CONSTRAINT "item_tags_item_id_fkey";

-- DropForeignKey
ALTER TABLE "metadata_source_records" DROP CONSTRAINT "metadata_source_records_item_id_fkey";

-- DropForeignKey
ALTER TABLE "notes" DROP CONSTRAINT "notes_item_id_fkey";

-- DropForeignKey
ALTER TABLE "user_item_states" DROP CONSTRAINT "user_item_states_item_id_fkey";

-- DropIndex
DROP INDEX "annotations_attachment_id_page_index_idx";

-- DropIndex
DROP INDEX "annotations_author_id_idx";

-- DropIndex
DROP INDEX "attachments_item_id_type_idx";

-- DropIndex
DROP INDEX "collection_items_collection_id_item_id_key";

-- DropIndex
DROP INDEX "collections_project_id_parent_id_created_at_idx";

-- DropIndex
DROP INDEX "collections_user_id_parent_id_created_at_idx";

-- DropIndex
DROP INDEX "full_text_indexes_attachment_id_page_index_idx";

-- DropIndex
DROP INDEX "idempotency_records_user_id_idempotency_key_idx";

-- DropIndex
DROP INDEX "ingestion_runs_project_id_status_idx";

-- DropIndex
DROP INDEX "ingestion_runs_user_id_status_idx";

-- DropIndex
DROP INDEX "item_tags_tag_id_item_id_key";

-- DropIndex
DROP INDEX "notes_item_id_idx";

-- DropIndex
DROP INDEX "notes_project_id_idx";

-- DropIndex
DROP INDEX "notes_user_id_idx";

-- DropIndex
DROP INDEX "saved_searches_project_id_idx";

-- DropIndex
DROP INDEX "saved_searches_user_id_idx";

-- DropIndex
DROP INDEX "tags_project_id_idx";

-- DropIndex
DROP INDEX "tags_user_id_name_key";

-- DropIndex
DROP INDEX "user_item_states_user_id_item_id_key";

-- AlterTable
ALTER TABLE "annotations" ADD COLUMN     "page_label" TEXT DEFAULT '';

-- AlterTable
ALTER TABLE "attachment_revisions" ADD COLUMN     "file_id" UUID,
ALTER COLUMN "size_bytes" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "attachments" DROP COLUMN "extracted_text",
DROP COLUMN "name",
DROP COLUMN "type",
ADD COLUMN     "page_count" INTEGER,
ALTER COLUMN "size" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "collection_items" DROP CONSTRAINT "collection_items_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "collection_items_pkey" PRIMARY KEY ("collection_id", "item_id");

-- AlterTable
ALTER TABLE "collections" ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
DROP COLUMN "created_by_id",
ADD COLUMN     "created_by_id" UUID;

-- AlterTable
ALTER TABLE "contributors" ADD COLUMN     "field_mode" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "orcid" VARCHAR(19);

-- AlterTable
ALTER TABLE "full_text_indexes" DROP CONSTRAINT "full_text_indexes_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "full_text_indexes_pkey" PRIMARY KEY ("attachment_id", "page_index");

-- AlterTable
ALTER TABLE "idempotency_records" DROP COLUMN "response";

-- AlterTable
ALTER TABLE "ingestion_runs" DROP COLUMN "requester_id",
ADD COLUMN     "current_stage" "IngestionStage",
ADD COLUMN     "next_retry_at" TIMESTAMPTZ(6),
ADD COLUMN     "review_data" JSONB,
ADD COLUMN     "trace_id" VARCHAR(64),
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL,
ALTER COLUMN "input_hash" SET DATA TYPE VARCHAR(64),
ALTER COLUMN "idempotency_key" SET DATA TYPE VARCHAR(128),
ALTER COLUMN "contract_version" SET DATA TYPE VARCHAR(16),
ALTER COLUMN "pipeline_version" SET DATA TYPE VARCHAR(16),
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "item_tags" DROP CONSTRAINT "item_tags_pkey",
DROP COLUMN "id",
ADD COLUMN     "type" "TagType" NOT NULL DEFAULT 'manual',
ADD CONSTRAINT "item_tags_pkey" PRIMARY KEY ("tag_id", "item_id");

-- AlterTable
ALTER TABLE "pages" DROP COLUMN "labels";

-- AlterTable
ALTER TABLE "saved_searches" DROP COLUMN "filters",
ALTER COLUMN "conditions" SET NOT NULL;

-- AlterTable
ALTER TABLE "sync_sequences" ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL;

-- AlterTable
ALTER TABLE "tags" ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "shortcut" INTEGER,
ALTER COLUMN "color" SET DEFAULT '#3b82f6',
DROP COLUMN "type",
ADD COLUMN     "type" "TagType" NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "user_item_states" DROP CONSTRAINT "user_item_states_pkey",
DROP COLUMN "id",
ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "is_starred" BOOLEAN NOT NULL DEFAULT false,
ADD CONSTRAINT "user_item_states_pkey" PRIMARY KEY ("user_id", "item_id");

-- DropTable
DROP TABLE "capture_previews";

-- DropTable
DROP TABLE "identifiers";

-- DropTable
DROP TABLE "ingestion_candidates";

-- DropTable
DROP TABLE "ingestion_decisions";

-- DropTable
DROP TABLE "ingestion_review_cases";

-- DropTable
DROP TABLE "ingestion_stages";

-- DropTable
DROP TABLE "item_revisions";

-- DropTable
DROP TABLE "metadata_source_records";

-- DropTable
DROP TABLE "papers";

-- DropTable
DROP TABLE "retraction_records";

-- DropEnum
DROP TYPE "RagStatus";

-- CreateTable
CREATE TABLE "items" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'journalArticle',
    "year" INTEGER,
    "citation_key" TEXT,
    "doi" TEXT,
    "publication_title" TEXT,
    "abstract" TEXT,
    "url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "user_id" UUID NOT NULL,
    "project_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "has_file" BOOLEAN NOT NULL DEFAULT false,
    "attachment_count" INTEGER NOT NULL DEFAULT 0,
    "note_count" INTEGER NOT NULL DEFAULT 0,
    "first_author" VARCHAR(255),

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_metadata" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "source_uri" TEXT DEFAULT '',
    "source_provider" VARCHAR(64) NOT NULL DEFAULT 'arxiv',
    "raw_payload" JSONB NOT NULL,
    "format" VARCHAR(32) DEFAULT 'json',
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retractions" (
    "id" UUID NOT NULL,
    "doi" VARCHAR(255) NOT NULL,
    "pmid" VARCHAR(32),
    "title" TEXT,
    "is_retracted" BOOLEAN NOT NULL DEFAULT true,
    "nature" VARCHAR(32) NOT NULL DEFAULT 'retraction',
    "retraction_date" TIMESTAMPTZ(6),
    "notice_type" VARCHAR(64),
    "notice_url" TEXT,
    "reason" TEXT,
    "journal" VARCHAR(512),
    "source" VARCHAR(64) NOT NULL DEFAULT 'crossref',
    "raw_metadata" JSONB,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "retractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_publications" (
    "user_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "contributor_id" UUID,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "open_access_license" TEXT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_publications_pkey" PRIMARY KEY ("user_id","item_id")
);

-- CreateTable
CREATE TABLE "item_field_mappings" (
    "item_type" VARCHAR(64) NOT NULL,
    "base_field" VARCHAR(64) NOT NULL,
    "field_key" VARCHAR(64) NOT NULL,
    "field_label" VARCHAR(128),
    "order_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "item_field_mappings_pkey" PRIMARY KEY ("item_type","base_field")
);

-- CreateIndex
CREATE INDEX "items_project_id_deleted_at_idx" ON "items"("project_id", "deleted_at");

-- CreateIndex
CREATE INDEX "items_user_id_deleted_at_year_created_at_idx" ON "items"("user_id", "deleted_at", "year" DESC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "items_user_id_type_idx" ON "items"("user_id", "type");

-- CreateIndex
CREATE INDEX "items_user_id_has_file_deleted_at_idx" ON "items"("user_id", "has_file", "deleted_at");

-- CreateIndex
CREATE INDEX "items_doi_idx" ON "items"("doi");

-- CreateIndex
CREATE INDEX "items_citation_key_idx" ON "items"("citation_key");

-- CreateIndex
CREATE INDEX "items_publication_title_idx" ON "items"("publication_title");

-- CreateIndex
CREATE INDEX "items_metadata_idx" ON "items" USING GIN ("metadata");

-- CreateIndex
CREATE INDEX "item_metadata_item_id_source_provider_created_at_idx" ON "item_metadata"("item_id", "source_provider", "created_at" DESC);

-- CreateIndex
CREATE INDEX "item_metadata_source_provider_idx" ON "item_metadata"("source_provider");

-- CreateIndex
CREATE UNIQUE INDEX "retractions_doi_key" ON "retractions"("doi");

-- CreateIndex
CREATE INDEX "retractions_pmid_idx" ON "retractions"("pmid");

-- CreateIndex
CREATE INDEX "retractions_is_retracted_nature_idx" ON "retractions"("is_retracted", "nature");

-- CreateIndex
CREATE INDEX "retractions_checked_at_idx" ON "retractions"("checked_at" DESC);

-- CreateIndex
CREATE INDEX "user_publications_user_id_is_public_idx" ON "user_publications"("user_id", "is_public");

-- CreateIndex
CREATE INDEX "user_publications_item_id_idx" ON "user_publications"("item_id");

-- CreateIndex
CREATE INDEX "item_field_mappings_base_field_idx" ON "item_field_mappings"("base_field");

-- CreateIndex
CREATE INDEX "annotations_attachment_id_deleted_at_annotation_sort_index_idx" ON "annotations"("attachment_id", "deleted_at", "annotation_sort_index");

-- CreateIndex
CREATE INDEX "annotations_attachment_id_deleted_at_page_index_idx" ON "annotations"("attachment_id", "deleted_at", "page_index");

-- CreateIndex
CREATE INDEX "annotations_author_id_deleted_at_idx" ON "annotations"("author_id", "deleted_at");

-- CreateIndex
CREATE INDEX "annotations_tags_idx" ON "annotations" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "attachment_revisions_file_id_idx" ON "attachment_revisions"("file_id");

-- CreateIndex
CREATE INDEX "attachments_item_id_attachment_type_idx" ON "attachments"("item_id", "attachment_type");

-- CreateIndex
CREATE INDEX "attachments_item_id_deleted_at_idx" ON "attachments"("item_id", "deleted_at");

-- CreateIndex
CREATE INDEX "attachments_extraction_status_extraction_started_at_idx" ON "attachments"("extraction_status", "extraction_started_at");

-- CreateIndex
CREATE INDEX "collection_items_collection_id_sort_order_idx" ON "collection_items"("collection_id", "sort_order");

-- CreateIndex
CREATE INDEX "collections_parent_id_idx" ON "collections"("parent_id");

-- CreateIndex
CREATE INDEX "collections_user_id_parent_id_sort_order_deleted_at_idx" ON "collections"("user_id", "parent_id", "sort_order", "deleted_at");

-- CreateIndex
CREATE INDEX "collections_project_id_parent_id_deleted_at_idx" ON "collections"("project_id", "parent_id", "deleted_at");

-- CreateIndex
CREATE INDEX "contributors_orcid_idx" ON "contributors"("orcid");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_idempotency_key_key" ON "idempotency_records"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ingestion_runs_user_id_started_at_idx" ON "ingestion_runs"("user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "ingestion_runs_project_id_started_at_idx" ON "ingestion_runs"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "ingestion_runs_item_id_idx" ON "ingestion_runs"("item_id");

-- CreateIndex
CREATE INDEX "ingestion_runs_status_next_retry_at_idx" ON "ingestion_runs"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "ingestion_runs_status_updated_at_idx" ON "ingestion_runs"("status", "updated_at");

-- CreateIndex
CREATE INDEX "ingestion_runs_user_id_input_hash_idx" ON "ingestion_runs"("user_id", "input_hash");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_user_id_idempotency_key_key" ON "ingestion_runs"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "library_changes_entity_type_entity_id_idx" ON "library_changes"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notes_item_id_deleted_at_idx" ON "notes"("item_id", "deleted_at");

-- CreateIndex
CREATE INDEX "notes_user_id_deleted_at_updated_at_idx" ON "notes"("user_id", "deleted_at", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "notes_project_id_deleted_at_idx" ON "notes"("project_id", "deleted_at");

-- CreateIndex
CREATE INDEX "notes_tags_idx" ON "notes" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "outbox_events_status_scheduled_at_lease_expires_at_idx" ON "outbox_events"("status", "scheduled_at", "lease_expires_at");

-- CreateIndex
CREATE INDEX "outbox_events_dedupe_key_idx" ON "outbox_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "saved_searches_user_id_deleted_at_idx" ON "saved_searches"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX "saved_searches_project_id_deleted_at_idx" ON "saved_searches"("project_id", "deleted_at");

-- CreateIndex
CREATE INDEX "tags_project_id_name_idx" ON "tags"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_user_id_name_project_id_key" ON "tags"("user_id", "name", "project_id");

-- CreateIndex
CREATE INDEX "tombstones_user_id_seq_idx" ON "tombstones"("user_id", "seq");

-- CreateIndex
CREATE INDEX "tombstones_project_id_seq_idx" ON "tombstones"("project_id", "seq");

-- CreateIndex
CREATE INDEX "user_item_states_user_id_is_starred_idx" ON "user_item_states"("user_id", "is_starred");

-- CreateIndex
CREATE INDEX "user_item_states_user_id_last_opened_at_idx" ON "user_item_states"("user_id", "last_opened_at" DESC);

-- CreateIndex
CREATE INDEX "user_item_states_item_id_idx" ON "user_item_states"("item_id");

-- AddForeignKey
ALTER TABLE "user_item_states" ADD CONSTRAINT "user_item_states_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contributors" ADD CONSTRAINT "contributors_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_target_item_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_metadata" ADD CONSTRAINT "item_metadata_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_publications" ADD CONSTRAINT "user_publications_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

