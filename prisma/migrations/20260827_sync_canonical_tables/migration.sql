-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'cycle';
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'file';
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'sticky';
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'comment';
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'collection';
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'worklog';

-- DropForeignKey
ALTER TABLE "federated_identities" DROP CONSTRAINT IF EXISTS "federated_identities_user_id_fkey";

-- DropForeignKey
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_item_id_fkey";

-- DropForeignKey
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "paper_attachments" DROP CONSTRAINT IF EXISTS "paper_attachments_paperId_fkey";

-- DropForeignKey
ALTER TABLE "security_audit_logs" DROP CONSTRAINT IF EXISTS "security_audit_logs_actor_id_fkey";

-- DropForeignKey
ALTER TABLE "user_item_states" DROP CONSTRAINT IF EXISTS "user_item_states_item_id_fkey";

-- DropForeignKey
ALTER TABLE "user_item_states" DROP CONSTRAINT IF EXISTS "user_item_states_user_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "workspace_invitations_invited_by_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "workspace_invitations_workspace_id_fkey";

-- DropIndex
DROP INDEX IF EXISTS "activity_events_entityType_entityId_idx";

-- DropIndex
DROP INDEX IF EXISTS "ai_messages_chatId_idx";

-- DropIndex
DROP INDEX IF EXISTS "cycles_projectId_status_idx";

-- DropIndex
DROP INDEX IF EXISTS "files_authorId_idx";

-- DropIndex
ALTER TABLE "idempotency_records" DROP CONSTRAINT IF EXISTS "idempotency_records_idempotency_key_key";

-- DropIndex
DROP INDEX IF EXISTS "page_comments_pageId_idx";

-- DropIndex
DROP INDEX IF EXISTS "page_versions_pageId_idx";

-- DropIndex
DROP INDEX IF EXISTS "pages_parentPageId_idx";

-- DropIndex
DROP INDEX IF EXISTS "pages_workspaceId_projectId_status_idx";

-- DropIndex
DROP INDEX IF EXISTS "paper_attachments_paperId_idx";

-- DropIndex
DROP INDEX IF EXISTS "projects_isActive_idx";

-- DropIndex
DROP INDEX IF EXISTS "projects_workspaceId_idx";

-- DropIndex
DROP INDEX IF EXISTS "stickies_projectId_userId_idx";

-- DropIndex
DROP INDEX IF EXISTS "stickies_workspaceId_createdAt_idx";

-- DropIndex
DROP INDEX IF EXISTS "tasks_cycleId_idx";

-- AlterTable
ALTER TABLE "collections" DROP COLUMN IF EXISTS "createdAt",
DROP COLUMN IF EXISTS "createdById",
DROP COLUMN IF EXISTS "parentId",
DROP COLUMN IF EXISTS "updatedAt",
DROP COLUMN IF EXISTS "workspaceId",
ADD COLUMN     IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "cycles" ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "federated_identities" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "files" DROP COLUMN IF EXISTS "deleted_at",
DROP COLUMN IF EXISTS "metadata";

-- AlterTable
ALTER TABLE "idempotency_records" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "labels" DROP COLUMN IF EXISTS "deleted_at";

-- AlterTable
ALTER TABLE "notes" ADD COLUMN     IF NOT EXISTS "deleted_at" TIMESTAMP(3),
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     IF NOT EXISTS "scheduled_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     IF NOT EXISTS "workspace_id" TEXT,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "pages" ALTER COLUMN "rank" SET NOT NULL,
ALTER COLUMN "is_locked" SET NOT NULL,
ALTER COLUMN "is_published" SET NOT NULL;

-- AlterTable
ALTER TABLE "paper_attachments" DROP COLUMN IF EXISTS "fileId",
DROP COLUMN IF EXISTS "paper_id",
ALTER COLUMN "paperId" SET NOT NULL;

-- AlterTable
ALTER TABLE "papers" ALTER COLUMN "version" SET NOT NULL;

-- AlterTable
ALTER TABLE "project_members" ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
DELETE FROM "refresh_tokens";
ALTER TABLE "refresh_tokens" ALTER COLUMN "token_hash" SET NOT NULL,
ALTER COLUMN "family_id" SET NOT NULL,
ALTER COLUMN "family_id" DROP DEFAULT,
ALTER COLUMN "is_revoked" SET NOT NULL,
ALTER COLUMN "last_used_at" SET NOT NULL,
ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "security_audit_logs" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tasks" ALTER COLUMN "archived_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_item_states" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "last_read_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "status" SET NOT NULL,
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workspace_invitations" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "accepted_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workspace_members" ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "plan" SET NOT NULL,
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_contributors" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "creator_type" TEXT NOT NULL DEFAULT 'author',
    "first_name" TEXT DEFAULT '',
    "last_name" TEXT DEFAULT '',
    "full_name" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_contributors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_identifiers" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "canonical_uri" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "collection_items" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "type" TEXT NOT NULL DEFAULT 'manual',
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_item_tags" (
    "id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "metadata_source_records" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "source_provider" TEXT NOT NULL,
    "raw_payload" JSONB,
    "snapshot_hash" TEXT,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metadata_source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "metadata_assertions" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source_provider" TEXT NOT NULL,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "is_user_override" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metadata_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_item_revisions" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changes_snapshot" JSONB NOT NULL,
    "changed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "attachment_revisions" (
    "id" TEXT NOT NULL,
    "attachment_id" TEXT NOT NULL,
    "revision_number" INTEGER NOT NULL DEFAULT 1,
    "file_hash" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT NOT NULL,
    "comment" TEXT DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "annotations" (
    "id" TEXT NOT NULL,
    "attachment_id" TEXT NOT NULL,
    "type" "AnnotationType" NOT NULL DEFAULT 'highlight',
    "page_index" INTEGER NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#ffeb3b',
    "quote_text" TEXT,
    "comment" TEXT DEFAULT '',
    "rect_coords" JSONB,
    "author_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "item_relations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_item_id" TEXT NOT NULL,
    "target_item_id" TEXT NOT NULL,
    "relation_type" "RelationType" NOT NULL DEFAULT 'cites',
    "description" TEXT DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ingestion_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "item_id" TEXT,
    "status" "IngestionStatus" NOT NULL DEFAULT 'RECEIVED',
    "idempotency_key" TEXT,
    "input_params" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL,
    "pipeline_version" TEXT NOT NULL DEFAULT '1.0.0',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "last_error" TEXT,
    "execution_log" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ingestion_stages" (
    "id" TEXT NOT NULL,
    "ingestion_run_id" TEXT NOT NULL,
    "stage_name" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "output_snapshot" JSONB,
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sync_sequences" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "current_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "library_changes" (
    "seq" BIGSERIAL NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_changes_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "tombstones" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "seq" BIGINT,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_by_id" TEXT,

    CONSTRAINT "tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "saved_searches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "color" TEXT DEFAULT '#3370ff',
    "icon" TEXT DEFAULT 'search',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "full_text_indexes" (
    "id" TEXT NOT NULL,
    "attachment_id" TEXT NOT NULL,
    "page_index" INTEGER NOT NULL,
    "text_content" TEXT NOT NULL,
    "char_offset" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "full_text_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "duplicate_clusters" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "item_ids" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "match_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "duplicate_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "worklogs" (
    "id" TEXT NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "task_id" TEXT,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worklogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_contributors_catalog_item_id_order_index_idx" ON "catalog_contributors"("catalog_item_id", "order_index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_contributors_full_name_idx" ON "catalog_contributors"("full_name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_identifiers_catalog_item_id_type_idx" ON "catalog_identifiers"("catalog_item_id", "type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_identifiers_type_value_idx" ON "catalog_identifiers"("type", "value");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_identifiers_canonical_uri_idx" ON "catalog_identifiers"("canonical_uri");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "collection_items_collection_id_idx" ON "collection_items"("collection_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "collection_items_catalog_item_id_idx" ON "collection_items"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "collection_items_collection_id_catalog_item_id_key" ON "collection_items"("collection_id", "catalog_item_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_tags_workspace_id_name_idx" ON "catalog_tags"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_tags_workspace_id_name_key" ON "catalog_tags"("workspace_id", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_item_tags_tag_id_idx" ON "catalog_item_tags"("tag_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_item_tags_catalog_item_id_idx" ON "catalog_item_tags"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_item_tags_tag_id_catalog_item_id_key" ON "catalog_item_tags"("tag_id", "catalog_item_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metadata_source_records_catalog_item_id_source_provider_idx" ON "metadata_source_records"("catalog_item_id", "source_provider");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metadata_source_records_snapshot_hash_idx" ON "metadata_source_records"("snapshot_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metadata_assertions_catalog_item_id_field_idx" ON "metadata_assertions"("catalog_item_id", "field");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metadata_assertions_is_user_override_idx" ON "metadata_assertions"("is_user_override");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_item_revisions_catalog_item_id_version_idx" ON "catalog_item_revisions"("catalog_item_id", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "attachment_revisions_attachment_id_revision_number_idx" ON "attachment_revisions"("attachment_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "attachment_revisions_attachment_id_revision_number_key" ON "attachment_revisions"("attachment_id", "revision_number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "annotations_attachment_id_page_index_idx" ON "annotations"("attachment_id", "page_index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "annotations_attachment_id_deleted_at_idx" ON "annotations"("attachment_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "item_relations_workspace_id_source_item_id_idx" ON "item_relations"("workspace_id", "source_item_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "item_relations_target_item_id_idx" ON "item_relations"("target_item_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "item_relations_source_item_id_target_item_id_relation_type_key" ON "item_relations"("source_item_id", "target_item_id", "relation_type");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_runs_idempotency_key_key" ON "ingestion_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ingestion_runs_workspace_id_status_idx" ON "ingestion_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ingestion_runs_input_hash_idx" ON "ingestion_runs"("input_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ingestion_stages_ingestion_run_id_stage_name_idx" ON "ingestion_stages"("ingestion_run_id", "stage_name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sync_sequences_workspace_id_key" ON "sync_sequences"("workspace_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "library_changes_workspace_id_seq_idx" ON "library_changes"("workspace_id", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "library_changes_workspace_id_entity_type_entity_id_idx" ON "library_changes"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "library_changes_workspace_id_seq_key" ON "library_changes"("workspace_id", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tombstones_workspace_id_deleted_at_idx" ON "tombstones"("workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tombstones_workspace_id_seq_idx" ON "tombstones"("workspace_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tombstones_workspace_id_entity_type_entity_id_key" ON "tombstones"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "saved_searches_workspace_id_user_id_idx" ON "saved_searches"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "full_text_indexes_attachment_id_page_index_idx" ON "full_text_indexes"("attachment_id", "page_index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "duplicate_clusters_workspace_id_status_idx" ON "duplicate_clusters"("workspace_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "worklogs_project_id_date_idx" ON "worklogs"("project_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "worklogs_user_id_date_idx" ON "worklogs"("user_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "worklogs_task_id_idx" ON "worklogs"("task_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "activity_events_workspace_id_entity_type_created_at_idx" ON "activity_events"("workspace_id", "entity_type", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "activity_events_entity_type_entity_id_created_at_idx" ON "activity_events"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_chats_project_id_user_id_updated_at_idx" ON "ai_chats"("project_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_chats_user_id_idx" ON "ai_chats"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_messages_chat_id_created_at_idx" ON "ai_messages"("chat_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cycles_project_id_status_deleted_at_idx" ON "cycles"("project_id", "status", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cycles_project_id_order_idx" ON "cycles"("project_id", "order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cycles_deleted_at_idx" ON "cycles"("deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "files_workspace_id_is_folder_trashed_at_idx" ON "files"("workspace_id", "is_folder", "trashed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "files_author_id_trashed_at_idx" ON "files"("author_id", "trashed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "files_trashed_at_idx" ON "files"("trashed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idempotency_records_idempotency_key_workspace_id_idx" ON "idempotency_records"("idempotency_key", "workspace_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_workspace_id_idempotency_key_key" ON "idempotency_records"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notes_workspace_id_item_id_created_at_idx" ON "notes"("workspace_id", "item_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notes_workspace_id_deleted_at_idx" ON "notes"("workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_events_workspace_id_status_idx" ON "outbox_events"("workspace_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "page_comments_page_id_status_idx" ON "page_comments"("page_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "page_versions_page_id_created_at_idx" ON "page_versions"("page_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pages_project_id_parent_page_id_rank_idx" ON "pages"("project_id", "parent_page_id", "rank");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pages_project_id_status_deleted_at_idx" ON "pages"("project_id", "status", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pages_workspace_id_project_id_deleted_at_idx" ON "pages"("workspace_id", "project_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pages_parent_page_id_deleted_at_idx" ON "pages"("parent_page_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pages_deleted_at_idx" ON "pages"("deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "paper_attachments_paperId_idx" ON "paper_attachments"("paperId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "papers_workspace_id_rag_status_idx" ON "papers"("workspace_id", "rag_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_members_project_id_role_idx" ON "project_members"("project_id", "role");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "projects_workspace_id_is_active_deleted_at_idx" ON "projects"("workspace_id", "is_active", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "projects_lead_id_idx" ON "projects"("lead_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "projects_deleted_at_idx" ON "projects"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "projects_workspace_id_identifier_key" ON "projects"("workspace_id", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_is_revoked_expires_at_idx" ON "refresh_tokens"("user_id", "is_revoked", "expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_revoked_at_expires_at_idx" ON "refresh_tokens"("user_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refresh_tokens_token_hash_idx" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stickies_workspace_id_user_id_scope_order_idx" ON "stickies"("workspace_id", "user_id", "scope", "order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stickies_project_id_user_id_scope_order_idx" ON "stickies"("project_id", "user_id", "scope", "order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stickies_user_id_idx" ON "stickies"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_project_id_completed_deleted_at_idx" ON "tasks"("project_id", "completed", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_cycle_id_deleted_at_idx" ON "tasks"("cycle_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_deleted_at_idx" ON "tasks"("deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_item_states_user_id_read_status_idx" ON "user_item_states"("user_id", "read_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_item_states_item_id_idx" ON "user_item_states"("item_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_status_deleted_at_idx" ON "users"("status", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspace_members_workspace_id_role_idx" ON "workspace_members"("workspace_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspaces_url_idx" ON "workspaces"("url");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspaces_slug_idx" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspaces_invite_code_idx" ON "workspaces"("invite_code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspaces_deleted_at_idx" ON "workspaces"("deleted_at");

-- AddForeignKey
ALTER TABLE "federated_identities" DROP CONSTRAINT IF EXISTS "federated_identities_user_id_fkey";
ALTER TABLE "federated_identities" ADD CONSTRAINT "federated_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_parent_id_fkey";
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "workspace_invitations_workspace_id_fkey";
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "workspace_invitations_invited_by_id_fkey";
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_logs" DROP CONSTRAINT IF EXISTS "security_audit_logs_actor_id_fkey";
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_lead_id_fkey";
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_contributors" DROP CONSTRAINT IF EXISTS "catalog_contributors_catalog_item_id_fkey";
ALTER TABLE "catalog_contributors" ADD CONSTRAINT "catalog_contributors_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_identifiers" DROP CONSTRAINT IF EXISTS "catalog_identifiers_catalog_item_id_fkey";
ALTER TABLE "catalog_identifiers" ADD CONSTRAINT "catalog_identifiers_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" DROP CONSTRAINT IF EXISTS "collection_items_collection_id_fkey";
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" DROP CONSTRAINT IF EXISTS "collection_items_catalog_item_id_fkey";
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_tags" DROP CONSTRAINT IF EXISTS "catalog_tags_workspace_id_fkey";
ALTER TABLE "catalog_tags" ADD CONSTRAINT "catalog_tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_tags" DROP CONSTRAINT IF EXISTS "catalog_item_tags_tag_id_fkey";
ALTER TABLE "catalog_item_tags" ADD CONSTRAINT "catalog_item_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "catalog_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_tags" DROP CONSTRAINT IF EXISTS "catalog_item_tags_catalog_item_id_fkey";
ALTER TABLE "catalog_item_tags" ADD CONSTRAINT "catalog_item_tags_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metadata_source_records" DROP CONSTRAINT IF EXISTS "metadata_source_records_catalog_item_id_fkey";
ALTER TABLE "metadata_source_records" ADD CONSTRAINT "metadata_source_records_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metadata_assertions" DROP CONSTRAINT IF EXISTS "metadata_assertions_catalog_item_id_fkey";
ALTER TABLE "metadata_assertions" ADD CONSTRAINT "metadata_assertions_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_revisions" DROP CONSTRAINT IF EXISTS "catalog_item_revisions_catalog_item_id_fkey";
ALTER TABLE "catalog_item_revisions" ADD CONSTRAINT "catalog_item_revisions_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_attachments" DROP CONSTRAINT IF EXISTS "paper_attachments_paperId_fkey";
ALTER TABLE "paper_attachments" ADD CONSTRAINT "paper_attachments_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_revisions" DROP CONSTRAINT IF EXISTS "attachment_revisions_attachment_id_fkey";
ALTER TABLE "attachment_revisions" ADD CONSTRAINT "attachment_revisions_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "paper_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" DROP CONSTRAINT IF EXISTS "annotations_attachment_id_fkey";
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "paper_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" DROP CONSTRAINT IF EXISTS "annotations_author_id_fkey";
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_workspace_id_fkey";
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_item_id_fkey";
ALTER TABLE "notes" ADD CONSTRAINT "notes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_created_by_id_fkey";
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" DROP CONSTRAINT IF EXISTS "item_relations_workspace_id_fkey";
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" DROP CONSTRAINT IF EXISTS "item_relations_source_item_id_fkey";
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" DROP CONSTRAINT IF EXISTS "item_relations_target_item_id_fkey";
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_target_item_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" DROP CONSTRAINT IF EXISTS "ingestion_runs_workspace_id_fkey";
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" DROP CONSTRAINT IF EXISTS "ingestion_runs_item_id_fkey";
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "papers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_stages" DROP CONSTRAINT IF EXISTS "ingestion_stages_ingestion_run_id_fkey";
ALTER TABLE "ingestion_stages" ADD CONSTRAINT "ingestion_stages_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sequences" DROP CONSTRAINT IF EXISTS "sync_sequences_workspace_id_fkey";
ALTER TABLE "sync_sequences" ADD CONSTRAINT "sync_sequences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_changes" DROP CONSTRAINT IF EXISTS "library_changes_workspace_id_fkey";
ALTER TABLE "library_changes" ADD CONSTRAINT "library_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tombstones" DROP CONSTRAINT IF EXISTS "tombstones_workspace_id_fkey";
ALTER TABLE "tombstones" ADD CONSTRAINT "tombstones_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_item_states" DROP CONSTRAINT IF EXISTS "user_item_states_user_id_fkey";
ALTER TABLE "user_item_states" ADD CONSTRAINT "user_item_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_item_states" DROP CONSTRAINT IF EXISTS "user_item_states_item_id_fkey";
ALTER TABLE "user_item_states" ADD CONSTRAINT "user_item_states_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_searches" DROP CONSTRAINT IF EXISTS "saved_searches_workspace_id_fkey";
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_searches" DROP CONSTRAINT IF EXISTS "saved_searches_user_id_fkey";
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "full_text_indexes" DROP CONSTRAINT IF EXISTS "full_text_indexes_attachment_id_fkey";
ALTER TABLE "full_text_indexes" ADD CONSTRAINT "full_text_indexes_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "paper_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_clusters" DROP CONSTRAINT IF EXISTS "duplicate_clusters_workspace_id_fkey";
ALTER TABLE "duplicate_clusters" ADD CONSTRAINT "duplicate_clusters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worklogs" DROP CONSTRAINT IF EXISTS "worklogs_task_id_fkey";
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worklogs" DROP CONSTRAINT IF EXISTS "worklogs_project_id_fkey";
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worklogs" DROP CONSTRAINT IF EXISTS "worklogs_user_id_fkey";
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

