-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."AnnotationType" AS ENUM ('highlight', 'underline', 'strike', 'note', 'rect', 'text', 'image', 'ink');

-- CreateEnum
CREATE TYPE "public"."AttachmentExtractionStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'COMPLETED', 'FAILED', 'FAILED_RETRYABLE', 'FAILED_FINAL');

-- CreateEnum
CREATE TYPE "public"."AttachmentType" AS ENUM ('primary_pdf', 'supplementary', 'dataset', 'slides', 'code', 'figure', 'snapshot', 'other', 'preview');

-- CreateEnum
CREATE TYPE "public"."AuditOutcome" AS ENUM ('success', 'failure', 'denied');

-- CreateEnum
CREATE TYPE "public"."AuditSeverity" AS ENUM ('info', 'warning', 'error', 'critical');

-- CreateEnum
CREATE TYPE "public"."AuthProvider" AS ENUM ('google', 'github', 'orcid', 'saml', 'local');

-- CreateEnum
CREATE TYPE "public"."BlobStatus" AS ENUM ('PENDING', 'READY', 'DELETED');

-- CreateEnum
CREATE TYPE "public"."ConversationMemberRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "public"."ConversationType" AS ENUM ('direct', 'group', 'project_channel');

-- CreateEnum
CREATE TYPE "public"."EntityType" AS ENUM ('space', 'paper', 'page', 'cycle', 'file', 'experiment', 'sticky', 'comment', 'collection', 'project', 'work_item', 'item');

-- CreateEnum
CREATE TYPE "public"."FilePermission" AS ENUM ('view', 'edit');

-- CreateEnum
CREATE TYPE "public"."FriendshipStatus" AS ENUM ('pending', 'accepted', 'declined', 'blocked');

-- CreateEnum
CREATE TYPE "public"."IngestionStage" AS ENUM ('IDENTIFY', 'EXTRACT', 'NORMALIZE', 'ENRICH', 'RECONCILE', 'MATCH', 'COMMIT');

-- CreateEnum
CREATE TYPE "public"."IngestionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED', 'STALLED');

-- CreateEnum
CREATE TYPE "public"."IntegrationProvider" AS ENUM ('zotero', 'mendeley', 'orcid', 'github');

-- CreateEnum
CREATE TYPE "public"."IntegrationStatus" AS ENUM ('connected', 'expired', 'revoked', 'error');

-- CreateEnum
CREATE TYPE "public"."InvitationStatus" AS ENUM ('pending', 'accepted', 'declined', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "public"."LinkMode" AS ENUM ('imported_file', 'imported_url', 'linked_url', 'linked_file');

-- CreateEnum
CREATE TYPE "public"."MessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "public"."MessageType" AS ENUM ('text', 'image', 'file', 'system');

-- CreateEnum
CREATE TYPE "public"."OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."PageChangeStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "public"."PageChangeType" AS ENUM ('insert', 'delete');

-- CreateEnum
CREATE TYPE "public"."PageNodeType" AS ENUM ('FOLDER', 'DOC', 'FILE');

-- CreateEnum
CREATE TYPE "public"."PageReviewStatus" AS ENUM ('draft', 'in_review', 'changes_requested', 'approved', 'submitted', 'locked');

-- CreateEnum
CREATE TYPE "public"."PageTemplateCategory" AS ENUM ('journal', 'conference', 'thesis', 'cv', 'presentation', 'report', 'other');

-- CreateEnum
CREATE TYPE "public"."ProjectPriority" AS ENUM ('urgent', 'high', 'medium', 'low', 'none');

-- CreateEnum
CREATE TYPE "public"."ProjectUpdateStatus" AS ENUM ('on_track', 'at_risk', 'off_track');

-- CreateEnum
CREATE TYPE "public"."ReadStatus" AS ENUM ('unread', 'reading', 'completed');

-- CreateEnum
CREATE TYPE "public"."RelationType" AS ENUM ('cites', 'cited_by', 'replicates', 'extends', 'is_preprint_of', 'is_published_version_of', 'is_translation_of', 'supplements', 'related', 'rebuts', 'uses_dataset', 'survey_of');

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('owner', 'coordinator', 'contributor', 'reviewer');

-- CreateEnum
CREATE TYPE "public"."SpaceType" AS ENUM ('personal', 'project');

-- CreateEnum
CREATE TYPE "public"."TagType" AS ENUM ('manual', 'automatic');

-- CreateEnum
CREATE TYPE "public"."ThemePreference" AS ENUM ('light', 'dark', 'system');

-- CreateEnum
CREATE TYPE "public"."UploadSessionStatus" AS ENUM ('INITIALIZED', 'UPLOADING', 'COMPLETED', 'ABORTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('active', 'suspended', 'pending_verification', 'deactivated');

-- CreateEnum
CREATE TYPE "public"."VerificationTokenType" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "public"."WorkItemPriority" AS ENUM ('urgent', 'high', 'medium', 'low', 'none');

-- CreateEnum
CREATE TYPE "public"."WorkItemRelationType" AS ENUM ('blocks', 'blocked_by', 'relates_to', 'duplicate_of');

-- CreateTable
CREATE TABLE "public"."activity_events" (
    "id" UUID NOT NULL,
    "entity_type" "public"."EntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "field" TEXT,
    "old_value" TEXT,
    "new_value" TEXT,
    "old_identifier" TEXT,
    "new_identifier" TEXT,
    "actor_id" UUID NOT NULL,
    "space_id" UUID,
    "project_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ai_chats" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "page_id" UUID,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "summary" TEXT DEFAULT '',
    "document_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ai_messages" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "role" "public"."MessageRole" NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "sources" JSONB DEFAULT '[]',
    "widgets" JSONB DEFAULT '[]',
    "selection_context" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."annotations" (
    "id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "item_id" UUID,
    "image_file_id" UUID,
    "type" "public"."AnnotationType" NOT NULL DEFAULT 'highlight',
    "color" TEXT NOT NULL DEFAULT '#ffeb3b',
    "page_index" INTEGER NOT NULL DEFAULT 0,
    "page_label" TEXT DEFAULT '',
    "annotation_sort_index" TEXT NOT NULL DEFAULT '',
    "rect_coords" JSONB,
    "quote_text" TEXT,
    "comment" TEXT DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attachment_reading_states" (
    "user_id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "current_page" INTEGER NOT NULL DEFAULT 1,
    "scroll_offset_x" REAL NOT NULL DEFAULT 0,
    "scroll_offset_y" REAL NOT NULL DEFAULT 0,
    "zoom_scale" REAL NOT NULL DEFAULT 1.0,
    "rotation" SMALLINT NOT NULL DEFAULT 0,
    "view_mode" VARCHAR(32) NOT NULL DEFAULT 'continuous',
    "bookmarks" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attachment_reading_states_pkey" PRIMARY KEY ("user_id","attachment_id")
);

-- CreateTable
CREATE TABLE "public"."attachment_revisions" (
    "id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL DEFAULT 1,
    "file_id" UUID,
    "file_hash" TEXT,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "url" TEXT NOT NULL DEFAULT '',
    "comment" TEXT DEFAULT '',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attachment_structures" (
    "attachment_id" UUID NOT NULL,
    "quality_score" REAL,
    "engine_used" VARCHAR(64),
    "page_count" INTEGER NOT NULL DEFAULT 0,
    "sections" JSONB NOT NULL DEFAULT '[]',
    "figures" JSONB NOT NULL DEFAULT '[]',
    "tables" JSONB NOT NULL DEFAULT '[]',
    "formulas" JSONB NOT NULL DEFAULT '[]',
    "references" JSONB NOT NULL DEFAULT '[]',
    "fulltext_file_id" UUID,
    "fulltext_byte_size" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attachment_structures_pkey" PRIMARY KEY ("attachment_id")
);

-- CreateTable
CREATE TABLE "public"."attachments" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "link_mode" "public"."LinkMode" NOT NULL DEFAULT 'imported_file',
    "attachment_type" "public"."AttachmentType" NOT NULL DEFAULT 'primary_pdf',
    "filename" TEXT NOT NULL DEFAULT 'document.pdf',
    "url" TEXT NOT NULL DEFAULT '',
    "file_hash" TEXT,
    "file_id" UUID,
    "storage_key" TEXT,
    "mime_type" TEXT NOT NULL DEFAULT 'application/pdf',
    "size" BIGINT NOT NULL DEFAULT 0,
    "page_count" INTEGER,
    "extraction_status" "public"."AttachmentExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extraction_attempts" INTEGER NOT NULL DEFAULT 0,
    "extraction_started_at" TIMESTAMPTZ(6),
    "extraction_completed_at" TIMESTAMPTZ(6),
    "extraction_last_error" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB DEFAULT '{}',
    "created_by_id" UUID,
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "impersonator_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "outcome" "public"."AuditOutcome" NOT NULL DEFAULT 'success',
    "severity" "public"."AuditSeverity" NOT NULL DEFAULT 'info',
    "project_id" UUID,
    "target_type" VARCHAR(50),
    "target_id" VARCHAR(100),
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "trace_id" VARCHAR(64),
    "metadata" JSONB DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."capture_previews" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "source_url" TEXT NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "canonical_metadata" JSONB NOT NULL,
    "metadata_digest" VARCHAR(128),
    "claimed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capture_previews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."citation_styles" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "title" VARCHAR(512) NOT NULL,
    "xml_content" TEXT NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "citation_styles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."contributors" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "creator_type" TEXT NOT NULL DEFAULT 'author',
    "field_mode" INTEGER NOT NULL DEFAULT 0,
    "first_name" TEXT DEFAULT '',
    "last_name" TEXT DEFAULT '',
    "full_name" TEXT NOT NULL,
    "short_name" VARCHAR(255) DEFAULT '',
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contributors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."conversation_members" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "public"."ConversationMemberRole" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."conversations" (
    "id" UUID NOT NULL,
    "type" "public"."ConversationType" NOT NULL,
    "name" VARCHAR(100),
    "topic" VARCHAR(255),
    "avatar" TEXT,
    "project_id" UUID,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID NOT NULL,
    "last_message_at" TIMESTAMPTZ(6),
    "last_message_snippet" VARCHAR(255),
    "last_sender_name" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."custom_dictionary_words" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "word" VARCHAR(128) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_dictionary_words_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."entity_attachments" (
    "id" UUID NOT NULL,
    "entity_type" "public"."EntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "space_id" UUID,
    "filename" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storage_key" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "mime_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "metadata" JSONB DEFAULT '{}',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "entity_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."feed_item_read_states" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT true,
    "saved_item_id" UUID,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_item_read_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."feed_items" (
    "id" UUID NOT NULL,
    "feed_id" UUID NOT NULL,
    "guid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "pdf_url" TEXT,
    "doi" TEXT,
    "arxiv_id" TEXT,
    "primary_category" TEXT,
    "authors" JSONB NOT NULL DEFAULT '[]',
    "abstract" TEXT,
    "license" TEXT,
    "comments" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."feed_subscriptions" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "feed_id" UUID NOT NULL,
    "custom_title" TEXT,
    "cleanup_read_after" INTEGER NOT NULL DEFAULT 30,
    "cleanup_unread_after" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feed_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."feeds" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "site_url" TEXT,
    "description" TEXT,
    "etag" TEXT,
    "last_modified" TEXT,
    "last_fetched_at" TIMESTAMPTZ(6),
    "last_status" INTEGER,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "refresh_interval" INTEGER NOT NULL DEFAULT 7200,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."file_blob_refs" (
    "blob_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "owner_type" VARCHAR(64) NOT NULL,
    "owner_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_blob_refs_pkey" PRIMARY KEY ("owner_type","owner_id")
);

-- CreateTable
CREATE TABLE "public"."file_blobs" (
    "id" UUID NOT NULL,
    "content_hash" BYTEA NOT NULL,
    "hash_algorithm" VARCHAR(16) NOT NULL DEFAULT 'SHA256',
    "size_bytes" BIGINT NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "bucket" VARCHAR(63) NOT NULL,
    "storage_class" VARCHAR(32) NOT NULL DEFAULT 'STANDARD',
    "ref_count" INTEGER NOT NULL DEFAULT 1,
    "status" "public"."BlobStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tombstone_at" TIMESTAMPTZ(6),
    "checksum_verified" BOOLEAN NOT NULL DEFAULT false,
    "claimed_at" TIMESTAMPTZ(6),
    "mime_type" VARCHAR(127) NOT NULL DEFAULT 'application/octet-stream',

    CONSTRAINT "file_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."file_nodes" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mime_type" VARCHAR(127) NOT NULL DEFAULT 'application/octet-stream',
    "is_folder" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB DEFAULT '{}',
    "parent_id" UUID,
    "linked_to_type" VARCHAR(64),
    "linked_to_id" VARCHAR(128),
    "blob_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "file_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."file_shares" (
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission" "public"."FilePermission" NOT NULL DEFAULT 'view',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_shares_pkey" PRIMARY KEY ("file_id","user_id")
);

-- CreateTable
CREATE TABLE "public"."file_stars" (
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_file_stars" PRIMARY KEY ("file_id","user_id")
);

-- CreateTable
CREATE TABLE "public"."file_uploads" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "upload_id" VARCHAR(1024) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL DEFAULT 'application/octet-stream',
    "total_size" BIGINT NOT NULL,
    "part_size" INTEGER NOT NULL,
    "expected_hash" BYTEA,
    "parent_id" UUID,
    "status" "public"."UploadSessionStatus" NOT NULL DEFAULT 'INITIALIZED',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "file_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."file_versions" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "blob_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "change_comment" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."friendships" (
    "id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "addressee_id" UUID NOT NULL,
    "status" "public"."FriendshipStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."full_text_indexes" (
    "attachment_id" UUID NOT NULL,
    "page_index" INTEGER NOT NULL,
    "text_content" TEXT NOT NULL,
    "char_offset" INTEGER NOT NULL DEFAULT 0,
    "search_vector" tsvector,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "full_text_indexes_pkey" PRIMARY KEY ("attachment_id","page_index")
);

-- CreateTable
CREATE TABLE "public"."idempotency_records" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT,
    "status_code" INTEGER,
    "response_body" JSONB,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ingestion_runs" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "trace_id" VARCHAR(64),
    "input_params" JSONB NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(128),
    "contract_version" VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    "pipeline_version" VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    "status" "public"."IngestionStatus" NOT NULL DEFAULT 'PENDING',
    "current_stage" "public"."IngestionStage",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "next_retry_at" TIMESTAMPTZ(6),
    "item_id" UUID,
    "last_error" TEXT,
    "execution_log" JSONB,
    "review_data" JSONB,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."item_identifiers" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "value" TEXT NOT NULL,
    "canonical_uri" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."item_metadata" (
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
CREATE TABLE "public"."item_relations" (
    "id" UUID NOT NULL,
    "source_item_id" UUID NOT NULL,
    "target_item_id" UUID NOT NULL,
    "relation_type" "public"."RelationType" NOT NULL DEFAULT 'related',
    "description" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."library_changes" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "actor_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."library_collection_items" (
    "collection_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_collection_items_pkey" PRIMARY KEY ("collection_id","item_id")
);

-- CreateTable
CREATE TABLE "public"."library_collections" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT DEFAULT '',
    "color" TEXT,
    "icon" TEXT DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "deleted_by_id" UUID,
    "parent_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "library_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."library_inbox_records" (
    "consumer" VARCHAR(128) NOT NULL,
    "event_id" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'processing',
    "owner_token" VARCHAR(64),
    "lease_expires_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "library_inbox_records_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "public"."library_item_states" (
    "user_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "read_status" "public"."ReadStatus" NOT NULL DEFAULT 'unread',
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "rating" INTEGER,
    "current_page" INTEGER,
    "scroll_position" JSONB,
    "last_active_attachment_id" UUID,
    "last_opened_at" TIMESTAMPTZ(6),
    "last_read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "library_item_states_pkey" PRIMARY KEY ("user_id","item_id")
);

-- CreateTable
CREATE TABLE "public"."library_item_tags" (
    "tag_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "type" "public"."TagType" NOT NULL DEFAULT 'manual',
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_item_tags_pkey" PRIMARY KEY ("tag_id","item_id")
);

-- CreateTable
CREATE TABLE "public"."library_items" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'journalArticle',
    "year" INTEGER,
    "citation_key" TEXT,
    "doi" TEXT,
    "isbn" TEXT,
    "issn" TEXT,
    "pmid" TEXT,
    "pmcid" TEXT,
    "arxiv_id" TEXT,
    "publication_title" TEXT,
    "abstract" TEXT,
    "url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "has_file" BOOLEAN NOT NULL DEFAULT false,
    "attachment_count" INTEGER NOT NULL DEFAULT 0,
    "note_count" INTEGER NOT NULL DEFAULT 0,
    "first_author" VARCHAR(255),
    "is_retracted" BOOLEAN NOT NULL DEFAULT false,
    "retraction_checked_at" TIMESTAMPTZ(6),
    "search_vector" tsvector,

    CONSTRAINT "library_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."library_notes" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "item_id" UUID,
    "title" TEXT NOT NULL DEFAULT 'Untitled Note',
    "content_md" TEXT NOT NULL DEFAULT '',
    "content_json" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "library_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."library_saved_searches" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT DEFAULT '',
    "description" TEXT DEFAULT '',
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "conjunction" TEXT DEFAULT 'AND',
    "sort_by" TEXT DEFAULT 'dateAdded',
    "sort_order" TEXT DEFAULT 'desc',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "icon" TEXT DEFAULT '',
    "color" TEXT,
    "cached_count" INTEGER NOT NULL DEFAULT 0,
    "last_evaluated_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "deleted_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "library_saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."library_tags" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL DEFAULT '',
    "color" TEXT DEFAULT '#3b82f6',
    "shortcut" INTEGER,
    "type" "public"."TagType" NOT NULL DEFAULT 'manual',
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "library_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."message_reactions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "type" "public"."MessageType" NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "attachments" JSONB DEFAULT '[]',
    "reply_to_id" UUID,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."outbox_events" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "actor_id" UUID,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "public"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "scheduled_at" TIMESTAMPTZ(6),
    "claimed_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "claimed_by" TEXT,
    "dedupe_key" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_comment_replies" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_comment_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_comment_threads" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "doc_id" UUID NOT NULL,
    "quote" TEXT,
    "start_line" INTEGER NOT NULL,
    "start_col" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "end_col" INTEGER NOT NULL,
    "is_resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_comment_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_doc_reviews" (
    "doc_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "status" "public"."PageReviewStatus" NOT NULL DEFAULT 'draft',
    "round_number" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "requested_by_id" UUID,
    "requested_at" TIMESTAMPTZ(6),
    "verdict_by_id" UUID,
    "verdict_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "deadline" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_doc_reviews_pkey" PRIMARY KEY ("doc_id")
);

-- CreateTable
CREATE TABLE "public"."page_docs" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "last_known_path" VARCHAR(1000) NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "rev" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "ranges" JSONB DEFAULT '{}',
    "hash" VARCHAR(64),
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "in_storage" BOOLEAN NOT NULL DEFAULT false,
    "storage_key" VARCHAR(512),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_files" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "last_known_path" VARCHAR(1000) NOT NULL,
    "mime_type" VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "hash" VARCHAR(64) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "bucket_name" VARCHAR(128) NOT NULL DEFAULT 'manuscript-files',
    "rev" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "blob_id" UUID,

    CONSTRAINT "page_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_nodes" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "parent_id" UUID,
    "type" "public"."PageNodeType" NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "path" VARCHAR(1000) NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "doc_id" UUID,
    "file_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_snapshot_labels" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_snapshot_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_snapshots" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "summary" VARCHAR(500),
    "created_by_id" UUID,
    "is_automatic" BOOLEAN NOT NULL DEFAULT false,
    "files" JSONB NOT NULL DEFAULT '{}',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "in_storage" BOOLEAN NOT NULL DEFAULT false,
    "storage_key" VARCHAR(512),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_templates" (
    "id" UUID NOT NULL,
    "version_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "category" "public"."PageTemplateCategory" NOT NULL DEFAULT 'other',
    "description" TEXT,
    "compiler" VARCHAR(32) NOT NULL DEFAULT 'pdflatex',
    "image_name" VARCHAR(128),
    "main_file" VARCHAR(255) NOT NULL DEFAULT 'main.tex',
    "thumbnail_url" TEXT,
    "author" VARCHAR(255) NOT NULL DEFAULT 'Flux Community',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_official" BOOLEAN NOT NULL DEFAULT false,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "files" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."page_track_changes" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "doc_id" UUID NOT NULL,
    "type" "public"."PageChangeType" NOT NULL,
    "status" "public"."PageChangeStatus" NOT NULL DEFAULT 'pending',
    "text" TEXT NOT NULL,
    "start_line" INTEGER NOT NULL,
    "start_col" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "end_col" INTEGER NOT NULL,
    "created_by_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_track_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."pages" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "root_doc_id" UUID,
    "title" VARCHAR(500) NOT NULL DEFAULT 'Untitled',
    "description" TEXT,
    "status" VARCHAR(50) NOT NULL DEFAULT 'draft',
    "compiler" VARCHAR(32) NOT NULL DEFAULT 'pdflatex',
    "tex_live_version" VARCHAR(16) NOT NULL DEFAULT '2024',
    "spell_check_language" VARCHAR(16) NOT NULL DEFAULT 'en_US',
    "pdf_thumbnail" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "deleted_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."project_favorites" (
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_project_favorites" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "public"."project_integration_links" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_integration_id" UUID NOT NULL,
    "collection_id" VARCHAR(255) NOT NULL,
    "collection_name" VARCHAR(255) NOT NULL,
    "target_bib_file" VARCHAR(255) NOT NULL DEFAULT 'references.bib',
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_integration_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."project_invitations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'contributor',
    "token_hash" VARCHAR(255) NOT NULL,
    "status" "public"."InvitationStatus" NOT NULL DEFAULT 'pending',
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."project_labels" (
    "project_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_project_labels" PRIMARY KEY ("project_id","label_id")
);

-- CreateTable
CREATE TABLE "public"."project_members" (
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'contributor',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_project_members" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "public"."project_states" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT DEFAULT '',
    "color" VARCHAR(30) NOT NULL DEFAULT '#0284c7',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "group" VARCHAR(50) NOT NULL DEFAULT 'execution',

    CONSTRAINT "project_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."project_updates" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "public"."ProjectUpdateStatus" NOT NULL DEFAULT 'on_track',
    "message" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."projects" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "identifier" VARCHAR(20) NOT NULL,
    "description" TEXT DEFAULT '',
    "avatar" TEXT,
    "cover_image" TEXT,
    "state_id" UUID,
    "priority" "public"."ProjectPriority" NOT NULL DEFAULT 'none',
    "start_date" DATE,
    "target_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "modules" TEXT[] DEFAULT ARRAY['overview', 'work_items', 'pages']::TEXT[],
    "settings" JSONB DEFAULT '{}',
    "work_item_sequence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "family_id" UUID NOT NULL,
    "parent_id" UUID,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "user_agent" VARCHAR(512),
    "ip_address" VARCHAR(45),
    "device_type" VARCHAR(50),
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."retractions" (
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
CREATE TABLE "public"."space_labels" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "color" VARCHAR(30) NOT NULL DEFAULT '#3b82f6',
    "description" VARCHAR(500),
    "sort_order" DOUBLE PRECISION NOT NULL DEFAULT 65535,
    "parent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "type" VARCHAR(50) NOT NULL DEFAULT 'work_item',

    CONSTRAINT "space_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."space_quotas" (
    "space_id" UUID NOT NULL,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "max_bytes" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "space_quotas_pkey" PRIMARY KEY ("space_id")
);

-- CreateTable
CREATE TABLE "public"."spaces" (
    "id" UUID NOT NULL,
    "type" "public"."SpaceType" NOT NULL,
    "owner_user_id" UUID,
    "project_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."stickies" (
    "id" UUID NOT NULL,
    "title" TEXT DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT 'yellow-1',
    "position_x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "stickies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sync_sequences" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "current_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tombstones" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "deleted_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "public"."AuthProvider" NOT NULL,
    "provider_subject_id" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "profile_data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_integrations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "public"."IntegrationProvider" NOT NULL,
    "status" "public"."IntegrationStatus" NOT NULL DEFAULT 'connected',
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "provider_user_id" VARCHAR(255) NOT NULL,
    "account_name" VARCHAR(255),
    "account_email" VARCHAR(255),
    "metadata" JSONB,
    "auth_failed_at" TIMESTAMPTZ(6),
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_profiles" (
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL DEFAULT 'User',
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "avatar_url" TEXT,
    "cover_image_url" TEXT,
    "institution" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "public"."user_publications" (
    "user_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "contributor_id" UUID,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "open_access_license" TEXT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_publications_pkey" PRIMARY KEY ("user_id","item_id")
);

-- CreateTable
CREATE TABLE "public"."user_settings" (
    "user_id" UUID NOT NULL,
    "theme" "public"."ThemePreference" NOT NULL DEFAULT 'system',
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "timezone" VARCHAR(50) DEFAULT 'UTC',
    "editor_config" JSONB NOT NULL DEFAULT '{}',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "notifications" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255),
    "status" "public"."UserStatus" NOT NULL DEFAULT 'pending_verification',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "type" "public"."VerificationTokenType" NOT NULL DEFAULT 'email_verification',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_item_assignees" (
    "work_item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_assignees_pkey" PRIMARY KEY ("work_item_id","user_id")
);

-- CreateTable
CREATE TABLE "public"."work_item_comments" (
    "id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "reactions" JSONB DEFAULT '[]',
    "replies" JSONB DEFAULT '[]',
    "attachments" JSONB DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_item_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_item_drafts" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "state_id" UUID,
    "priority" "public"."WorkItemPriority" NOT NULL DEFAULT 'none',
    "start_date" TIMESTAMPTZ(6),
    "due_date" TIMESTAMPTZ(6),
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignee_id" UUID,
    "assignee_ids" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_item_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_item_entity_links" (
    "id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "entity_type" "public"."EntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "description" TEXT DEFAULT '',
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_entity_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_item_label_assignments" (
    "work_item_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_label_assignments_pkey" PRIMARY KEY ("work_item_id","label_id")
);

-- CreateTable
CREATE TABLE "public"."work_item_relations" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "type" "public"."WorkItemRelationType" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_item_states" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#94a3b8',
    "icon" TEXT DEFAULT '',
    "group" TEXT NOT NULL DEFAULT 'backlog',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_item_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_items" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT DEFAULT '',
    "state_id" UUID NOT NULL,
    "start_date" TIMESTAMPTZ(6),
    "due_date" TIMESTAMPTZ(6),
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priority" "public"."WorkItemPriority" NOT NULL DEFAULT 'none',
    "identifier" TEXT,
    "sequence_number" INTEGER,
    "time_spent" DOUBLE PRECISION DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "project_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "assignee_id" UUID,
    "subscriber_ids" JSONB NOT NULL DEFAULT '[]',
    "parent_work_item_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_events_actor_id_created_at_idx" ON "public"."activity_events"("actor_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "activity_events_entity_type_entity_id_created_at_idx" ON "public"."activity_events"("entity_type" ASC, "entity_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "activity_events_project_id_created_at_idx" ON "public"."activity_events"("project_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "activity_events_space_id_created_at_idx" ON "public"."activity_events"("space_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "ai_chats_created_by_id_updated_at_idx" ON "public"."ai_chats"("created_by_id" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ai_chats_page_id_space_id_idx" ON "public"."ai_chats"("page_id" ASC, "space_id" ASC);

-- CreateIndex
CREATE INDEX "ai_chats_space_id_updated_at_idx" ON "public"."ai_chats"("space_id" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ai_messages_chat_id_created_at_idx" ON "public"."ai_messages"("chat_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "annotations_active_item_sort_idx" ON "public"."annotations"("item_id" ASC, "page_index" ASC, "annotation_sort_index" ASC);

-- CreateIndex
CREATE INDEX "annotations_attachment_id_deleted_at_page_index_annotation__idx" ON "public"."annotations"("attachment_id" ASC, "deleted_at" ASC, "page_index" ASC, "annotation_sort_index" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "annotations_attachment_id_deleted_at_type_page_index_annota_idx" ON "public"."annotations"("attachment_id" ASC, "deleted_at" ASC, "type" ASC, "page_index" ASC, "annotation_sort_index" ASC);

-- CreateIndex
CREATE INDEX "annotations_created_by_id_deleted_at_idx" ON "public"."annotations"("created_by_id" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "annotations_item_id_deleted_at_page_index_annotation_sort_i_idx" ON "public"."annotations"("item_id" ASC, "deleted_at" ASC, "page_index" ASC, "annotation_sort_index" ASC);

-- CreateIndex
CREATE INDEX "annotations_tags_idx" ON "public"."annotations" USING GIN ("tags" array_ops);

-- CreateIndex
CREATE INDEX "attachment_reading_states_attachment_id_idx" ON "public"."attachment_reading_states"("attachment_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_revisions_attachment_id_revision_number_key" ON "public"."attachment_revisions"("attachment_id" ASC, "revision_number" ASC);

-- CreateIndex
CREATE INDEX "attachment_revisions_file_id_idx" ON "public"."attachment_revisions"("file_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "attachments_active_item_file_hash_uq" ON "public"."attachments"("item_id" ASC, "file_hash" ASC);

-- CreateIndex
CREATE INDEX "attachments_extraction_status_extraction_started_at_idx" ON "public"."attachments"("extraction_status" ASC, "extraction_started_at" ASC);

-- CreateIndex
CREATE INDEX "attachments_file_hash_idx" ON "public"."attachments"("file_hash" ASC);

-- CreateIndex
CREATE INDEX "attachments_file_id_deleted_at_idx" ON "public"."attachments"("file_id" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "attachments_item_id_deleted_at_attachment_type_idx" ON "public"."attachments"("item_id" ASC, "deleted_at" ASC, "attachment_type" ASC);

-- CreateIndex
CREATE INDEX "attachments_item_id_deleted_at_created_at_idx" ON "public"."attachments"("item_id" ASC, "deleted_at" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "attachments_item_id_deleted_at_file_id_idx" ON "public"."attachments"("item_id" ASC, "deleted_at" ASC, "file_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_attachments_one_primary_per_item" ON "public"."attachments"("item_id" ASC);

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "public"."audit_logs"("action" ASC, "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "public"."audit_logs"("actor_id" ASC, "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_ip_address_action_occurred_at_idx" ON "public"."audit_logs"("ip_address" ASC, "action" ASC, "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_project_id_occurred_at_idx" ON "public"."audit_logs"("project_id" ASC, "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_severity_occurred_at_idx" ON "public"."audit_logs"("severity" ASC, "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_trace_id_idx" ON "public"."audit_logs"("trace_id" ASC);

-- CreateIndex
CREATE INDEX "capture_previews_created_by_id_expires_at_idx" ON "public"."capture_previews"("created_by_id" ASC, "expires_at" ASC);

-- CreateIndex
CREATE INDEX "capture_previews_expires_at_idx" ON "public"."capture_previews"("expires_at" ASC);

-- CreateIndex
CREATE INDEX "capture_previews_space_id_expires_at_idx" ON "public"."capture_previews"("space_id" ASC, "expires_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "capture_previews_token_hash_key" ON "public"."capture_previews"("token_hash" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "citation_styles_space_id_slug_key" ON "public"."citation_styles"("space_id" ASC, "slug" ASC);

-- CreateIndex
CREATE INDEX "contributors_full_name_idx" ON "public"."contributors"("full_name" ASC);

-- CreateIndex
CREATE INDEX "contributors_item_id_order_index_idx" ON "public"."contributors"("item_id" ASC, "order_index" ASC);

-- CreateIndex
CREATE INDEX "contributors_last_name_first_name_idx" ON "public"."contributors"("last_name" ASC, "first_name" ASC);

-- CreateIndex
CREATE INDEX "conversation_members_user_id_last_read_at_idx" ON "public"."conversation_members"("user_id" ASC, "last_read_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_conversation_member" ON "public"."conversation_members"("conversation_id" ASC, "user_id" ASC);

-- CreateIndex
CREATE INDEX "conversations_last_message_at_idx" ON "public"."conversations"("last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_project_id_idx" ON "public"."conversations"("project_id" ASC);

-- CreateIndex
CREATE INDEX "conversations_type_idx" ON "public"."conversations"("type" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_custom_dictionary_words_space_word" ON "public"."custom_dictionary_words"("space_id" ASC, "word" ASC);

-- CreateIndex
CREATE INDEX "idx_entity_attachments_creator" ON "public"."entity_attachments"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "idx_entity_attachments_entity" ON "public"."entity_attachments"("entity_type" ASC, "entity_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_entity_attachments_space" ON "public"."entity_attachments"("space_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "feed_item_read_states_item_id_user_id_read_at_idx" ON "public"."feed_item_read_states"("item_id" ASC, "user_id" ASC, "read_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "feed_item_read_states_user_id_item_id_key" ON "public"."feed_item_read_states"("user_id" ASC, "item_id" ASC);

-- CreateIndex
CREATE INDEX "feed_item_read_states_user_id_saved_item_id_idx" ON "public"."feed_item_read_states"("user_id" ASC, "saved_item_id" ASC);

-- CreateIndex
CREATE INDEX "feed_items_arxiv_id_idx" ON "public"."feed_items"("arxiv_id" ASC);

-- CreateIndex
CREATE INDEX "feed_items_doi_idx" ON "public"."feed_items"("doi" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "feed_items_feed_id_guid_key" ON "public"."feed_items"("feed_id" ASC, "guid" ASC);

-- CreateIndex
CREATE INDEX "feed_items_feed_id_published_at_id_idx" ON "public"."feed_items"("feed_id" ASC, "published_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "feed_items_guid_idx" ON "public"."feed_items"("guid" ASC);

-- CreateIndex
CREATE INDEX "feed_items_published_at_idx" ON "public"."feed_items"("published_at" ASC);

-- CreateIndex
CREATE INDEX "feed_items_url_idx" ON "public"."feed_items"("url" ASC);

-- CreateIndex
CREATE INDEX "feed_subscriptions_feed_id_idx" ON "public"."feed_subscriptions"("feed_id" ASC);

-- CreateIndex
CREATE INDEX "feed_subscriptions_space_id_created_at_idx" ON "public"."feed_subscriptions"("space_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "feed_subscriptions_space_id_feed_id_key" ON "public"."feed_subscriptions"("space_id" ASC, "feed_id" ASC);

-- CreateIndex
CREATE INDEX "feeds_error_count_last_fetched_at_idx" ON "public"."feeds"("error_count" ASC, "last_fetched_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "feeds_url_key" ON "public"."feeds"("url" ASC);

-- CreateIndex
CREATE INDEX "idx_file_blob_refs_blob_space" ON "public"."file_blob_refs"("blob_id" ASC, "space_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_blob_refs_space" ON "public"."file_blob_refs"("space_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_blobs_gc_claim_lease" ON "public"."file_blobs"("ref_count" ASC, "claimed_at" ASC);

-- CreateIndex
CREATE INDEX "idx_file_blobs_gc_ready" ON "public"."file_blobs"("tombstone_at" ASC, "claimed_at" ASC);

-- CreateIndex
CREATE INDEX "idx_file_blobs_orphan_gc" ON "public"."file_blobs"("ref_count" ASC, "tombstone_at" ASC);

-- CreateIndex
CREATE INDEX "idx_file_blobs_status" ON "public"."file_blobs"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_blobs_bucket_key" ON "public"."file_blobs"("bucket" ASC, "storage_key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_blobs_content_hash" ON "public"."file_blobs"("content_hash" ASC);

-- CreateIndex
CREATE INDEX "idx_file_nodes_blob_id" ON "public"."file_nodes"("blob_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_nodes_created_by" ON "public"."file_nodes"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_nodes_deleted_at" ON "public"."file_nodes"("deleted_at" ASC);

-- CreateIndex
CREATE INDEX "idx_file_nodes_linked_tree" ON "public"."file_nodes"("linked_to_type" ASC, "linked_to_id" ASC, "parent_id" ASC, "deleted_at" ASC, "is_folder" DESC, "filename" ASC);

-- CreateIndex
CREATE INDEX "idx_file_nodes_parent_deleted" ON "public"."file_nodes"("parent_id" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "idx_file_nodes_space_tree" ON "public"."file_nodes"("space_id" ASC, "parent_id" ASC, "deleted_at" ASC, "is_folder" DESC, "filename" ASC);

-- CreateIndex
CREATE INDEX "idx_file_nodes_space_updated" ON "public"."file_nodes"("space_id" ASC, "deleted_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_nodes_id_space" ON "public"."file_nodes"("id" ASC, "space_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_shares_user_created" ON "public"."file_shares"("user_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_file_stars_user_created" ON "public"."file_stars"("user_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_file_uploads_cleanup" ON "public"."file_uploads"("status" ASC, "expires_at" ASC);

-- CreateIndex
CREATE INDEX "idx_file_uploads_creator" ON "public"."file_uploads"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_uploads_parent" ON "public"."file_uploads"("parent_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_uploads_space" ON "public"."file_uploads"("space_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_uploads_key_upload" ON "public"."file_uploads"("storage_key" ASC, "upload_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_versions_blob_id" ON "public"."file_versions"("blob_id" ASC);

-- CreateIndex
CREATE INDEX "idx_file_versions_created_by" ON "public"."file_versions"("created_by_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_versions_file_version" ON "public"."file_versions"("file_id" ASC, "version_number" ASC);

-- CreateIndex
CREATE INDEX "friendships_addressee_id_status_idx" ON "public"."friendships"("addressee_id" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "friendships_requester_id_status_idx" ON "public"."friendships"("requester_id" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_friendship_pair" ON "public"."friendships"("requester_id" ASC, "addressee_id" ASC);

-- CreateIndex
CREATE INDEX "full_text_indexes_search_vector_idx" ON "public"."full_text_indexes" USING GIN ("search_vector" tsvector_ops);

-- CreateIndex
CREATE INDEX "idempotency_records_actor_id_idempotency_key_idx" ON "public"."idempotency_records"("actor_id" ASC, "idempotency_key" ASC);

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "public"."idempotency_records"("expires_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_space_id_idempotency_key_key" ON "public"."idempotency_records"("space_id" ASC, "idempotency_key" ASC);

-- CreateIndex
CREATE INDEX "ingestion_runs_created_by_id_started_at_idx" ON "public"."ingestion_runs"("created_by_id" ASC, "started_at" DESC);

-- CreateIndex
CREATE INDEX "ingestion_runs_item_id_idx" ON "public"."ingestion_runs"("item_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_space_id_idempotency_key_key" ON "public"."ingestion_runs"("space_id" ASC, "idempotency_key" ASC);

-- CreateIndex
CREATE INDEX "ingestion_runs_space_id_input_hash_idx" ON "public"."ingestion_runs"("space_id" ASC, "input_hash" ASC);

-- CreateIndex
CREATE INDEX "ingestion_runs_space_id_started_at_idx" ON "public"."ingestion_runs"("space_id" ASC, "started_at" DESC);

-- CreateIndex
CREATE INDEX "ingestion_runs_status_completed_at_idx" ON "public"."ingestion_runs"("status" ASC, "completed_at" ASC);

-- CreateIndex
CREATE INDEX "ingestion_runs_status_next_retry_at_idx" ON "public"."ingestion_runs"("status" ASC, "next_retry_at" ASC);

-- CreateIndex
CREATE INDEX "ingestion_runs_status_updated_at_idx" ON "public"."ingestion_runs"("status" ASC, "updated_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "item_identifiers_item_id_type_key" ON "public"."item_identifiers"("item_id" ASC, "type" ASC);

-- CreateIndex
CREATE INDEX "item_identifiers_type_value_idx" ON "public"."item_identifiers"("type" ASC, "value" ASC);

-- CreateIndex
CREATE INDEX "item_metadata_item_id_created_at_idx" ON "public"."item_metadata"("item_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "item_metadata_item_id_source_provider_created_at_idx" ON "public"."item_metadata"("item_id" ASC, "source_provider" ASC, "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "item_relations_source_item_id_target_item_id_relation_type_key" ON "public"."item_relations"("source_item_id" ASC, "target_item_id" ASC, "relation_type" ASC);

-- CreateIndex
CREATE INDEX "item_relations_target_item_id_idx" ON "public"."item_relations"("target_item_id" ASC);

-- CreateIndex
CREATE INDEX "library_changes_created_at_idx" ON "public"."library_changes"("created_at" ASC);

-- CreateIndex
CREATE INDEX "library_changes_space_id_entity_type_entity_id_seq_idx" ON "public"."library_changes"("space_id" ASC, "entity_type" ASC, "entity_id" ASC, "seq" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "library_changes_space_id_seq_key" ON "public"."library_changes"("space_id" ASC, "seq" ASC);

-- CreateIndex
CREATE INDEX "library_collection_items_collection_id_sort_order_idx" ON "public"."library_collection_items"("collection_id" ASC, "sort_order" ASC);

-- CreateIndex
CREATE INDEX "library_collection_items_item_id_idx" ON "public"."library_collection_items"("item_id" ASC);

-- CreateIndex
CREATE INDEX "library_collections_parent_id_idx" ON "public"."library_collections"("parent_id" ASC);

-- CreateIndex
CREATE INDEX "library_collections_space_id_deleted_at_created_at_idx" ON "public"."library_collections"("space_id" ASC, "deleted_at" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "library_collections_space_id_deleted_at_parent_id_sort_orde_idx" ON "public"."library_collections"("space_id" ASC, "deleted_at" ASC, "parent_id" ASC, "sort_order" ASC);

-- CreateIndex
CREATE INDEX "library_inbox_records_expires_at_idx" ON "public"."library_inbox_records"("expires_at" ASC);

-- CreateIndex
CREATE INDEX "library_inbox_records_status_lease_expires_at_idx" ON "public"."library_inbox_records"("status" ASC, "lease_expires_at" ASC);

-- CreateIndex
CREATE INDEX "library_item_states_item_id_idx" ON "public"."library_item_states"("item_id" ASC);

-- CreateIndex
CREATE INDEX "library_item_states_user_id_is_starred_idx" ON "public"."library_item_states"("user_id" ASC, "is_starred" ASC);

-- CreateIndex
CREATE INDEX "library_item_states_user_id_last_opened_at_item_id_idx" ON "public"."library_item_states"("user_id" ASC, "last_opened_at" DESC, "item_id" DESC);

-- CreateIndex
CREATE INDEX "library_item_states_user_id_last_read_at_item_id_idx" ON "public"."library_item_states"("user_id" ASC, "last_read_at" DESC, "item_id" DESC);

-- CreateIndex
CREATE INDEX "library_item_states_user_id_read_status_idx" ON "public"."library_item_states"("user_id" ASC, "read_status" ASC);

-- CreateIndex
CREATE INDEX "library_item_tags_item_id_idx" ON "public"."library_item_tags"("item_id" ASC);

-- CreateIndex
CREATE INDEX "library_item_tags_type_tag_id_idx" ON "public"."library_item_tags"("type" ASC, "tag_id" ASC);

-- CreateIndex
CREATE INDEX "library_items_citation_key_deleted_at_idx" ON "public"."library_items"("citation_key" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "library_items_created_by_id_idx" ON "public"."library_items"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "library_items_deleted_at_retraction_checked_at_idx" ON "public"."library_items"("deleted_at" ASC, "retraction_checked_at" ASC);

-- CreateIndex
CREATE INDEX "library_items_doi_deleted_at_idx" ON "public"."library_items"("doi" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "library_items_metadata_idx" ON "public"."library_items" USING GIN ("metadata" jsonb_ops);

-- CreateIndex
CREATE INDEX "library_items_retracted_active_partial_idx" ON "public"."library_items"("space_id" ASC);

-- CreateIndex
CREATE INDEX "library_items_search_vector_idx" ON "public"."library_items" USING GIN ("search_vector" tsvector_ops);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_arxiv_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "arxiv_id" ASC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_citation_key_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "citation_key" ASC, "id" ASC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_created_at_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_first_author_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "first_author" ASC, "id" ASC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_has_file_created_at_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "has_file" ASC, "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_is_retracted_created_at_i_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "is_retracted" ASC, "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_pmid_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "pmid" ASC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_publication_title_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "publication_title" ASC, "id" ASC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_title_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "title" ASC, "id" ASC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_type_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "type" ASC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_updated_at_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "library_items_space_id_deleted_at_year_id_idx" ON "public"."library_items"("space_id" ASC, "deleted_at" ASC, "year" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "library_notes_item_id_deleted_at_updated_at_idx" ON "public"."library_notes"("item_id" ASC, "deleted_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "library_notes_space_id_deleted_at_updated_at_idx" ON "public"."library_notes"("space_id" ASC, "deleted_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "library_notes_tags_idx" ON "public"."library_notes" USING GIN ("tags" array_ops);

-- CreateIndex
CREATE INDEX "library_saved_searches_space_id_deleted_at_is_pinned_name_idx" ON "public"."library_saved_searches"("space_id" ASC, "deleted_at" ASC, "is_pinned" DESC, "name" ASC);

-- CreateIndex
CREATE INDEX "library_tags_space_id_name_idx" ON "public"."library_tags"("space_id" ASC, "name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "library_tags_space_id_normalized_name_key" ON "public"."library_tags"("space_id" ASC, "normalized_name" ASC);

-- CreateIndex
CREATE INDEX "message_reactions_user_id_idx" ON "public"."message_reactions"("user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_message_user_reaction" ON "public"."message_reactions"("message_id" ASC, "user_id" ASC, "emoji" ASC);

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "public"."messages"("conversation_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_reply_to_id_idx" ON "public"."messages"("reply_to_id" ASC);

-- CreateIndex
CREATE INDEX "messages_sender_id_idx" ON "public"."messages"("sender_id" ASC);

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_id_status_idx" ON "public"."outbox_events"("aggregate_id" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "public"."outbox_events"("dedupe_key" ASC);

-- CreateIndex
CREATE INDEX "outbox_events_space_id_status_idx" ON "public"."outbox_events"("space_id" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "public"."outbox_events"("status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "outbox_events_status_lease_expires_at_idx" ON "public"."outbox_events"("status" ASC, "lease_expires_at" ASC);

-- CreateIndex
CREATE INDEX "outbox_events_status_scheduled_at_lease_expires_at_idx" ON "public"."outbox_events"("status" ASC, "scheduled_at" ASC, "lease_expires_at" ASC);

-- CreateIndex
CREATE INDEX "outbox_events_status_updated_at_idx" ON "public"."outbox_events"("status" ASC, "updated_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_comment_replies_thread" ON "public"."page_comment_replies"("thread_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_comments_author" ON "public"."page_comment_threads"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "idx_page_comments_doc_id" ON "public"."page_comment_threads"("doc_id" ASC, "is_resolved" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_page_comments_lookup" ON "public"."page_comment_threads"("space_id" ASC, "doc_id" ASC, "is_resolved" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_comments_page_lookup" ON "public"."page_comment_threads"("page_id" ASC, "doc_id" ASC, "is_resolved" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_comments_space_line_created" ON "public"."page_comment_threads"("space_id" ASC, "start_line" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_doc_reviews_space_status" ON "public"."page_doc_reviews"("space_id" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "idx_page_docs_page_del_path" ON "public"."page_docs"("page_id" ASC, "deleted_at" ASC, "last_known_path" ASC);

-- CreateIndex
CREATE INDEX "idx_page_docs_page_del_updated" ON "public"."page_docs"("page_id" ASC, "deleted_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_page_docs_space_deleted" ON "public"."page_docs"("space_id" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_docs_space_storage" ON "public"."page_docs"("space_id" ASC, "in_storage" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_docs_id_page" ON "public"."page_docs"("id" ASC, "page_id" ASC);

-- CreateIndex
CREATE INDEX "idx_page_files_blob_id" ON "public"."page_files"("blob_id" ASC);

-- CreateIndex
CREATE INDEX "idx_page_files_hash_deleted" ON "public"."page_files"("hash" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_files_page_del_created" ON "public"."page_files"("page_id" ASC, "deleted_at" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_page_files_page_del_path" ON "public"."page_files"("page_id" ASC, "deleted_at" ASC, "last_known_path" ASC);

-- CreateIndex
CREATE INDEX "idx_page_files_space_hash" ON "public"."page_files"("space_id" ASC, "hash" ASC);

-- CreateIndex
CREATE INDEX "idx_page_files_storage_key" ON "public"."page_files"("storage_key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_files_id_page" ON "public"."page_files"("id" ASC, "page_id" ASC);

-- CreateIndex
CREATE INDEX "idx_page_nodes_page_path_pattern" ON "public"."page_nodes"("page_id" ASC, "path" ASC);

-- CreateIndex
CREATE INDEX "idx_page_nodes_page_tree" ON "public"."page_nodes"("page_id" ASC, "depth" ASC, "sort_order" ASC, "name" ASC);

-- CreateIndex
CREATE INDEX "idx_page_nodes_page_type" ON "public"."page_nodes"("page_id" ASC, "type" ASC);

-- CreateIndex
CREATE INDEX "idx_page_nodes_space_id" ON "public"."page_nodes"("space_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_nodes_doc_id" ON "public"."page_nodes"("doc_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_nodes_file_id" ON "public"."page_nodes"("file_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_nodes_id_page" ON "public"."page_nodes"("id" ASC, "page_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_nodes_page_path" ON "public"."page_nodes"("page_id" ASC, "path" ASC);

-- CreateIndex
CREATE INDEX "idx_page_snapshot_labels_page_version" ON "public"."page_snapshot_labels"("page_id" ASC, "version" ASC);

-- CreateIndex
CREATE INDEX "idx_page_snapshot_labels_snapshot_id" ON "public"."page_snapshot_labels"("snapshot_id" ASC);

-- CreateIndex
CREATE INDEX "idx_page_snapshot_labels_space_label" ON "public"."page_snapshot_labels"("space_id" ASC, "label" ASC);

-- CreateIndex
CREATE INDEX "idx_page_snapshot_labels_space_version" ON "public"."page_snapshot_labels"("space_id" ASC, "version" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_snapshot_labels_page_label" ON "public"."page_snapshot_labels"("page_id" ASC, "label" ASC);

-- CreateIndex
CREATE INDEX "idx_page_snapshots_page_created_desc" ON "public"."page_snapshots"("page_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_page_snapshots_page_storage" ON "public"."page_snapshots"("page_id" ASC, "in_storage" ASC);

-- CreateIndex
CREATE INDEX "idx_page_snapshots_space_created_desc" ON "public"."page_snapshots"("space_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_page_snapshots_space_version" ON "public"."page_snapshots"("space_id" ASC, "version" ASC);

-- CreateIndex
CREATE INDEX "idx_page_snapshots_storage" ON "public"."page_snapshots"("space_id" ASC, "in_storage" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_snapshots_id_page" ON "public"."page_snapshots"("id" ASC, "page_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_snapshots_page_version" ON "public"."page_snapshots"("page_id" ASC, "version" ASC);

-- CreateIndex
CREATE INDEX "idx_page_templates_cat" ON "public"."page_templates"("category" ASC, "is_official" ASC, "download_count" DESC);

-- CreateIndex
CREATE INDEX "idx_page_templates_downloads" ON "public"."page_templates"("download_count" DESC);

-- CreateIndex
CREATE INDEX "idx_page_templates_official_downloads" ON "public"."page_templates"("is_official" DESC, "download_count" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "page_templates_version_id_key" ON "public"."page_templates"("version_id" ASC);

-- CreateIndex
CREATE INDEX "idx_page_changes_author" ON "public"."page_track_changes"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "idx_page_changes_doc_id" ON "public"."page_track_changes"("doc_id" ASC, "status" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_page_changes_lookup" ON "public"."page_track_changes"("space_id" ASC, "doc_id" ASC, "status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_changes_page_lookup" ON "public"."page_track_changes"("page_id" ASC, "doc_id" ASC, "status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_page_changes_space_line_created" ON "public"."page_track_changes"("space_id" ASC, "start_line" ASC, "start_col" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_pages_root_doc_id" ON "public"."pages"("root_doc_id" ASC);

-- CreateIndex
CREATE INDEX "idx_pages_space_title" ON "public"."pages"("space_id" ASC, "deleted_at" ASC, "title" ASC);

-- CreateIndex
CREATE INDEX "idx_pages_space_updated" ON "public"."pages"("space_id" ASC, "deleted_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_pages_id_space" ON "public"."pages"("id" ASC, "space_id" ASC);

-- CreateIndex
CREATE INDEX "idx_project_favorites_user_covering" ON "public"."project_favorites"("user_id" ASC, "project_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "project_integration_links_project_id_user_integration_id_co_key" ON "public"."project_integration_links"("project_id" ASC, "user_integration_id" ASC, "collection_id" ASC);

-- CreateIndex
CREATE INDEX "idx_project_invitations_email" ON "public"."project_invitations"("email" ASC);

-- CreateIndex
CREATE INDEX "idx_project_invitations_status" ON "public"."project_invitations"("project_id" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_project_invitations_token_hash" ON "public"."project_invitations"("token_hash" ASC);

-- CreateIndex
CREATE INDEX "idx_project_labels_covering" ON "public"."project_labels"("label_id" ASC, "project_id" ASC);

-- CreateIndex
CREATE INDEX "idx_project_members_role" ON "public"."project_members"("project_id" ASC, "role" ASC);

-- CreateIndex
CREATE INDEX "idx_project_members_user_covering" ON "public"."project_members"("user_id" ASC, "project_id" ASC);

-- CreateIndex
CREATE INDEX "idx_project_states_group_seq" ON "public"."project_states"("project_id" ASC, "group" ASC, "sequence" ASC);

-- CreateIndex
CREATE INDEX "idx_project_states_sequence" ON "public"."project_states"("project_id" ASC, "sequence" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_project_states_project_name" ON "public"."project_states"("project_id" ASC, "name" ASC);

-- CreateIndex
CREATE INDEX "idx_project_updates_timeline" ON "public"."project_updates"("project_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_projects_identifier" ON "public"."projects"("identifier" ASC);

-- CreateIndex
CREATE INDEX "idx_projects_operational_status" ON "public"."projects"("is_active" ASC, "is_archived" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "idx_projects_priority" ON "public"."projects"("priority" ASC);

-- CreateIndex
CREATE INDEX "idx_projects_state_id" ON "public"."projects"("state_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_projects_creator_identifier" ON "public"."projects"("created_by_id" ASC, "identifier" ASC);

-- CreateIndex
CREATE INDEX "idx_refresh_tokens_active" ON "public"."refresh_tokens"("user_id" ASC, "expires_at" ASC);

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "public"."refresh_tokens"("family_id" ASC);

-- CreateIndex
CREATE INDEX "refresh_tokens_parent_id_idx" ON "public"."refresh_tokens"("parent_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "public"."refresh_tokens"("token_hash" ASC);

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_is_revoked_expires_at_idx" ON "public"."refresh_tokens"("user_id" ASC, "is_revoked" ASC, "expires_at" ASC);

-- CreateIndex
CREATE INDEX "retractions_checked_at_idx" ON "public"."retractions"("checked_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "retractions_doi_key" ON "public"."retractions"("doi" ASC);

-- CreateIndex
CREATE INDEX "retractions_is_retracted_nature_idx" ON "public"."retractions"("is_retracted" ASC, "nature" ASC);

-- CreateIndex
CREATE INDEX "retractions_pmid_idx" ON "public"."retractions"("pmid" ASC);

-- CreateIndex
CREATE INDEX "idx_space_labels_type_sort" ON "public"."space_labels"("space_id" ASC, "type" ASC, "sort_order" ASC);

-- CreateIndex
CREATE INDEX "space_labels_created_by_id_idx" ON "public"."space_labels"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "space_labels_space_id_parent_id_idx" ON "public"."space_labels"("space_id" ASC, "parent_id" ASC);

-- CreateIndex
CREATE INDEX "space_labels_space_id_sort_order_idx" ON "public"."space_labels"("space_id" ASC, "sort_order" ASC);

-- CreateIndex
CREATE INDEX "idx_spaces_type" ON "public"."spaces"("type" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_spaces_owner_user_id" ON "public"."spaces"("owner_user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_spaces_project_id" ON "public"."spaces"("project_id" ASC);

-- CreateIndex
CREATE INDEX "stickies_user_id_deleted_at_order_idx" ON "public"."stickies"("user_id" ASC, "deleted_at" ASC, "order" ASC);

-- CreateIndex
CREATE INDEX "stickies_user_id_order_idx" ON "public"."stickies"("user_id" ASC, "order" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "sync_sequences_space_id_key" ON "public"."sync_sequences"("space_id" ASC);

-- CreateIndex
CREATE INDEX "tombstones_deleted_at_idx" ON "public"."tombstones"("deleted_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "tombstones_space_id_entity_type_entity_id_key" ON "public"."tombstones"("space_id" ASC, "entity_type" ASC, "entity_id" ASC);

-- CreateIndex
CREATE INDEX "tombstones_space_id_seq_idx" ON "public"."tombstones"("space_id" ASC, "seq" ASC);

-- CreateIndex
CREATE INDEX "user_accounts_email_idx" ON "public"."user_accounts"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_provider_provider_subject_id_key" ON "public"."user_accounts"("provider" ASC, "provider_subject_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_user_id_provider_key" ON "public"."user_accounts"("user_id" ASC, "provider" ASC);

-- CreateIndex
CREATE INDEX "user_integrations_provider_idx" ON "public"."user_integrations"("provider" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "user_integrations_user_id_provider_key" ON "public"."user_integrations"("user_id" ASC, "provider" ASC);

-- CreateIndex
CREATE INDEX "user_profiles_institution_idx" ON "public"."user_profiles"("institution" ASC);

-- CreateIndex
CREATE INDEX "user_profiles_name_idx" ON "public"."user_profiles"("name" ASC);

-- CreateIndex
CREATE INDEX "user_publications_contributor_id_idx" ON "public"."user_publications"("contributor_id" ASC);

-- CreateIndex
CREATE INDEX "user_publications_item_id_idx" ON "public"."user_publications"("item_id" ASC);

-- CreateIndex
CREATE INDEX "user_publications_user_id_is_public_idx" ON "public"."user_publications"("user_id" ASC, "is_public" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email" ASC);

-- CreateIndex
CREATE INDEX "users_status_deleted_at_idx" ON "public"."users"("status" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "idx_verification_tokens_active" ON "public"."verification_tokens"("user_id" ASC, "type" ASC, "expires_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_hash_key" ON "public"."verification_tokens"("token_hash" ASC);

-- CreateIndex
CREATE INDEX "work_item_assignees_user_id_idx" ON "public"."work_item_assignees"("user_id" ASC);

-- CreateIndex
CREATE INDEX "work_item_comments_created_by_id_idx" ON "public"."work_item_comments"("created_by_id" ASC);

-- CreateIndex
CREATE INDEX "work_item_comments_work_item_id_created_at_idx" ON "public"."work_item_comments"("work_item_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "work_item_drafts_created_by_id_created_at_idx" ON "public"."work_item_drafts"("created_by_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "work_item_drafts_space_id_updated_at_idx" ON "public"."work_item_drafts"("space_id" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "work_item_entity_links_entity_type_entity_id_idx" ON "public"."work_item_entity_links"("entity_type" ASC, "entity_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "work_item_entity_links_work_item_id_entity_type_entity_id_key" ON "public"."work_item_entity_links"("work_item_id" ASC, "entity_type" ASC, "entity_id" ASC);

-- CreateIndex
CREATE INDEX "work_item_label_assignments_label_id_idx" ON "public"."work_item_label_assignments"("label_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "work_item_relations_source_id_target_id_type_key" ON "public"."work_item_relations"("source_id" ASC, "target_id" ASC, "type" ASC);

-- CreateIndex
CREATE INDEX "work_item_relations_target_id_idx" ON "public"."work_item_relations"("target_id" ASC);

-- CreateIndex
CREATE INDEX "work_item_states_project_id_group_sequence_idx" ON "public"."work_item_states"("project_id" ASC, "group" ASC, "sequence" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "work_item_states_project_id_name_key" ON "public"."work_item_states"("project_id" ASC, "name" ASC);

-- CreateIndex
CREATE INDEX "work_items_assignee_id_deleted_at_archived_at_updated_at_idx" ON "public"."work_items"("assignee_id" ASC, "deleted_at" ASC, "archived_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "work_items_created_by_id_deleted_at_updated_at_idx" ON "public"."work_items"("created_by_id" ASC, "deleted_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "work_items_project_id_completed_deleted_at_idx" ON "public"."work_items"("project_id" ASC, "completed" ASC, "deleted_at" ASC);

-- CreateIndex
CREATE INDEX "work_items_project_id_deleted_at_archived_at_rank_idx" ON "public"."work_items"("project_id" ASC, "deleted_at" ASC, "archived_at" ASC, "rank" ASC);

-- CreateIndex
CREATE INDEX "work_items_project_id_deleted_at_due_date_idx" ON "public"."work_items"("project_id" ASC, "deleted_at" ASC, "due_date" ASC);

-- CreateIndex
CREATE INDEX "work_items_project_id_deleted_at_updated_at_idx" ON "public"."work_items"("project_id" ASC, "deleted_at" ASC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "work_items_project_id_identifier_idx" ON "public"."work_items"("project_id" ASC, "identifier" ASC);

-- CreateIndex
CREATE INDEX "work_items_project_id_parent_work_item_id_rank_idx" ON "public"."work_items"("project_id" ASC, "parent_work_item_id" ASC, "rank" ASC);

-- CreateIndex
CREATE INDEX "work_items_project_id_state_id_deleted_at_rank_idx" ON "public"."work_items"("project_id" ASC, "state_id" ASC, "deleted_at" ASC, "rank" ASC);

-- CreateIndex
CREATE INDEX "work_items_project_id_state_id_rank_idx" ON "public"."work_items"("project_id" ASC, "state_id" ASC, "rank" ASC);

-- AddForeignKey
ALTER TABLE "public"."activity_events" ADD CONSTRAINT "activity_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."activity_events" ADD CONSTRAINT "activity_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."activity_events" ADD CONSTRAINT "activity_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ai_chats" ADD CONSTRAINT "ai_chats_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ai_chats" ADD CONSTRAINT "ai_chats_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ai_messages" ADD CONSTRAINT "ai_messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."ai_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."annotations" ADD CONSTRAINT "fk_annotations_attachment_id" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attachment_reading_states" ADD CONSTRAINT "fk_att_reading_states_attachment_id" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attachment_revisions" ADD CONSTRAINT "fk_attachment_revisions_attachment_id" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attachment_structures" ADD CONSTRAINT "fk_attachment_structures_attachment_id" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attachments" ADD CONSTRAINT "fk_attachments_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."capture_previews" ADD CONSTRAINT "fk_capture_previews_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."citation_styles" ADD CONSTRAINT "fk_citation_styles_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contributors" ADD CONSTRAINT "fk_contributors_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversations" ADD CONSTRAINT "conversations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversations" ADD CONSTRAINT "conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."custom_dictionary_words" ADD CONSTRAINT "fk_custom_dictionary_words_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."entity_attachments" ADD CONSTRAINT "entity_attachments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."entity_attachments" ADD CONSTRAINT "fk_entity_attachments_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."feed_item_read_states" ADD CONSTRAINT "fk_feed_item_read_states_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."feed_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."feed_items" ADD CONSTRAINT "fk_feed_items_feed_id" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."feed_subscriptions" ADD CONSTRAINT "fk_feed_subscriptions_feed_id" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."feed_subscriptions" ADD CONSTRAINT "fk_feed_subscriptions_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_blob_refs" ADD CONSTRAINT "fk_file_blob_refs_blob_id" FOREIGN KEY ("blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_blob_refs" ADD CONSTRAINT "fk_file_blob_refs_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_nodes" ADD CONSTRAINT "fk_file_nodes_blob_id" FOREIGN KEY ("blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_nodes" ADD CONSTRAINT "fk_file_nodes_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_nodes" ADD CONSTRAINT "fk_file_nodes_parent_id" FOREIGN KEY ("parent_id") REFERENCES "public"."file_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_nodes" ADD CONSTRAINT "fk_file_nodes_parent_same_space" FOREIGN KEY ("parent_id", "space_id") REFERENCES "public"."file_nodes"("id", "space_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_nodes" ADD CONSTRAINT "fk_file_nodes_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_shares" ADD CONSTRAINT "fk_file_shares_file_id" FOREIGN KEY ("file_id") REFERENCES "public"."file_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_shares" ADD CONSTRAINT "fk_file_shares_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_stars" ADD CONSTRAINT "fk_file_stars_file_id" FOREIGN KEY ("file_id") REFERENCES "public"."file_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_stars" ADD CONSTRAINT "fk_file_stars_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_uploads" ADD CONSTRAINT "fk_file_uploads_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_uploads" ADD CONSTRAINT "fk_file_uploads_parent_id" FOREIGN KEY ("parent_id") REFERENCES "public"."file_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_uploads" ADD CONSTRAINT "fk_file_uploads_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_versions" ADD CONSTRAINT "fk_file_versions_blob_id" FOREIGN KEY ("blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_versions" ADD CONSTRAINT "fk_file_versions_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_versions" ADD CONSTRAINT "fk_file_versions_file_id" FOREIGN KEY ("file_id") REFERENCES "public"."file_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."friendships" ADD CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."friendships" ADD CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."full_text_indexes" ADD CONSTRAINT "fk_full_text_indexes_attachment_id" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."idempotency_records" ADD CONSTRAINT "fk_idempotency_records_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ingestion_runs" ADD CONSTRAINT "fk_ingestion_runs_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ingestion_runs" ADD CONSTRAINT "fk_ingestion_runs_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."item_identifiers" ADD CONSTRAINT "fk_item_identifiers_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."item_metadata" ADD CONSTRAINT "fk_item_metadata_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."item_relations" ADD CONSTRAINT "fk_item_relations_source_item_id" FOREIGN KEY ("source_item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."item_relations" ADD CONSTRAINT "fk_item_relations_target_item_id" FOREIGN KEY ("target_item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_changes" ADD CONSTRAINT "fk_library_changes_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_collection_items" ADD CONSTRAINT "fk_library_collection_items_collection_id" FOREIGN KEY ("collection_id") REFERENCES "public"."library_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_collection_items" ADD CONSTRAINT "fk_library_collection_items_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_collections" ADD CONSTRAINT "fk_library_collections_parent_id" FOREIGN KEY ("parent_id") REFERENCES "public"."library_collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_collections" ADD CONSTRAINT "fk_library_collections_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_item_states" ADD CONSTRAINT "fk_library_item_states_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_item_tags" ADD CONSTRAINT "fk_library_item_tags_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_item_tags" ADD CONSTRAINT "fk_library_item_tags_tag_id" FOREIGN KEY ("tag_id") REFERENCES "public"."library_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_items" ADD CONSTRAINT "fk_library_items_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_notes" ADD CONSTRAINT "fk_library_notes_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_notes" ADD CONSTRAINT "fk_library_notes_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_saved_searches" ADD CONSTRAINT "fk_library_saved_searches_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."library_tags" ADD CONSTRAINT "fk_library_tags_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."outbox_events" ADD CONSTRAINT "fk_outbox_events_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_comment_replies" ADD CONSTRAINT "fk_page_comment_replies_thread_id" FOREIGN KEY ("thread_id") REFERENCES "public"."page_comment_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_comment_threads" ADD CONSTRAINT "fk_page_comment_threads_doc_id" FOREIGN KEY ("doc_id") REFERENCES "public"."page_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_comment_threads" ADD CONSTRAINT "fk_page_comment_threads_doc_same_page" FOREIGN KEY ("doc_id", "page_id") REFERENCES "public"."page_docs"("id", "page_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_comment_threads" ADD CONSTRAINT "fk_page_comment_threads_page_space" FOREIGN KEY ("page_id", "space_id") REFERENCES "public"."pages"("id", "space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_doc_reviews" ADD CONSTRAINT "fk_page_doc_review_doc_id" FOREIGN KEY ("doc_id") REFERENCES "public"."page_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_doc_reviews" ADD CONSTRAINT "fk_page_doc_review_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_docs" ADD CONSTRAINT "fk_page_docs_page_space" FOREIGN KEY ("page_id", "space_id") REFERENCES "public"."pages"("id", "space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_files" ADD CONSTRAINT "fk_page_files_blob_id" FOREIGN KEY ("blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_files" ADD CONSTRAINT "fk_page_files_page_space" FOREIGN KEY ("page_id", "space_id") REFERENCES "public"."pages"("id", "space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_nodes" ADD CONSTRAINT "fk_page_nodes_doc_id" FOREIGN KEY ("doc_id") REFERENCES "public"."page_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_nodes" ADD CONSTRAINT "fk_page_nodes_doc_same_page" FOREIGN KEY ("doc_id", "page_id") REFERENCES "public"."page_docs"("id", "page_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_nodes" ADD CONSTRAINT "fk_page_nodes_file_id" FOREIGN KEY ("file_id") REFERENCES "public"."page_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_nodes" ADD CONSTRAINT "fk_page_nodes_file_same_page" FOREIGN KEY ("file_id", "page_id") REFERENCES "public"."page_files"("id", "page_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_nodes" ADD CONSTRAINT "fk_page_nodes_page_space" FOREIGN KEY ("page_id", "space_id") REFERENCES "public"."pages"("id", "space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_nodes" ADD CONSTRAINT "fk_page_nodes_parent_id" FOREIGN KEY ("parent_id") REFERENCES "public"."page_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_nodes" ADD CONSTRAINT "fk_page_nodes_parent_same_page" FOREIGN KEY ("parent_id", "page_id") REFERENCES "public"."page_nodes"("id", "page_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_snapshot_labels" ADD CONSTRAINT "fk_page_snapshot_labels_page_space" FOREIGN KEY ("page_id", "space_id") REFERENCES "public"."pages"("id", "space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_snapshot_labels" ADD CONSTRAINT "fk_page_snapshot_labels_snapshot_id" FOREIGN KEY ("snapshot_id") REFERENCES "public"."page_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_snapshot_labels" ADD CONSTRAINT "fk_page_snapshot_labels_snapshot_same_page" FOREIGN KEY ("snapshot_id", "page_id") REFERENCES "public"."page_snapshots"("id", "page_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_snapshots" ADD CONSTRAINT "fk_page_snapshots_page_space" FOREIGN KEY ("page_id", "space_id") REFERENCES "public"."pages"("id", "space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_track_changes" ADD CONSTRAINT "fk_page_track_changes_doc_id" FOREIGN KEY ("doc_id") REFERENCES "public"."page_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_track_changes" ADD CONSTRAINT "fk_page_track_changes_doc_same_page" FOREIGN KEY ("doc_id", "page_id") REFERENCES "public"."page_docs"("id", "page_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."page_track_changes" ADD CONSTRAINT "fk_page_track_changes_page_space" FOREIGN KEY ("page_id", "space_id") REFERENCES "public"."pages"("id", "space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pages" ADD CONSTRAINT "fk_pages_root_doc_id" FOREIGN KEY ("root_doc_id") REFERENCES "public"."page_docs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pages" ADD CONSTRAINT "fk_pages_root_doc_same_page" FOREIGN KEY ("root_doc_id", "id") REFERENCES "public"."page_docs"("id", "page_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pages" ADD CONSTRAINT "fk_pages_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_favorites" ADD CONSTRAINT "fk_project_favorites_project_id" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_favorites" ADD CONSTRAINT "fk_project_favorites_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_integration_links" ADD CONSTRAINT "project_integration_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_integration_links" ADD CONSTRAINT "project_integration_links_user_integration_id_fkey" FOREIGN KEY ("user_integration_id") REFERENCES "public"."user_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_invitations" ADD CONSTRAINT "fk_project_invitations_project_id" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_labels" ADD CONSTRAINT "fk_project_labels_label_id" FOREIGN KEY ("label_id") REFERENCES "public"."space_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_labels" ADD CONSTRAINT "fk_project_labels_project_id" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_members" ADD CONSTRAINT "fk_project_members_project_id" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_members" ADD CONSTRAINT "fk_project_members_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_states" ADD CONSTRAINT "fk_project_states_project_id" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_updates" ADD CONSTRAINT "fk_project_updates_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_updates" ADD CONSTRAINT "fk_project_updates_project_id" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."projects" ADD CONSTRAINT "fk_projects_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."projects" ADD CONSTRAINT "projects_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "public"."project_states"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."space_labels" ADD CONSTRAINT "space_labels_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."space_labels" ADD CONSTRAINT "space_labels_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."space_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."space_labels" ADD CONSTRAINT "space_labels_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."space_quotas" ADD CONSTRAINT "fk_space_quotas_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."spaces" ADD CONSTRAINT "fk_spaces_owner_user_id" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."spaces" ADD CONSTRAINT "fk_spaces_project_id" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stickies" ADD CONSTRAINT "stickies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sync_sequences" ADD CONSTRAINT "fk_sync_sequences_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tombstones" ADD CONSTRAINT "fk_tombstones_space_id" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_accounts" ADD CONSTRAINT "user_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_integrations" ADD CONSTRAINT "user_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_publications" ADD CONSTRAINT "fk_user_publications_contributor_id" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_publications" ADD CONSTRAINT "fk_user_publications_item_id" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_assignees" ADD CONSTRAINT "work_item_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_assignees" ADD CONSTRAINT "work_item_assignees_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_comments" ADD CONSTRAINT "work_item_comments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_comments" ADD CONSTRAINT "work_item_comments_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_drafts" ADD CONSTRAINT "work_item_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_drafts" ADD CONSTRAINT "work_item_drafts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_entity_links" ADD CONSTRAINT "work_item_entity_links_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_label_assignments" ADD CONSTRAINT "work_item_label_assignments_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "public"."space_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_label_assignments" ADD CONSTRAINT "work_item_label_assignments_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_relations" ADD CONSTRAINT "work_item_relations_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_relations" ADD CONSTRAINT "work_item_relations_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_item_states" ADD CONSTRAINT "work_item_states_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_items" ADD CONSTRAINT "work_items_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_items" ADD CONSTRAINT "work_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_items" ADD CONSTRAINT "work_items_parent_work_item_id_fkey" FOREIGN KEY ("parent_work_item_id") REFERENCES "public"."work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_items" ADD CONSTRAINT "work_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_items" ADD CONSTRAINT "work_items_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "public"."work_item_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

