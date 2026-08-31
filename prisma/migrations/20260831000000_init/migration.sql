-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'pending_verification', 'deactivated');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('google', 'github', 'orcid', 'saml', 'local');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'declined', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('login_success', 'login_failed', 'logout', 'token_refreshed', 'token_revoked', 'token_breach_detected', 'password_reset_requested', 'password_reset_completed', 'oauth_account_linked', 'oauth_account_unlinked', 'member_invited', 'member_joined', 'member_role_updated', 'member_removed', 'mfa_enabled', 'mfa_disabled');

-- CreateEnum
CREATE TYPE "WorkspaceMemberRole" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- CreateEnum
CREATE TYPE "ProjectMemberRole" AS ENUM ('admin', 'contributor', 'commenter', 'viewer');

-- CreateEnum
CREATE TYPE "FilePermission" AS ENUM ('view', 'edit');

-- CreateEnum
CREATE TYPE "RagStatus" AS ENUM ('pending', 'indexed', 'failed');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('primary_pdf', 'supplementary', 'dataset', 'slides', 'code', 'figure', 'other');

-- CreateEnum
CREATE TYPE "AnnotationType" AS ENUM ('highlight', 'underline', 'note', 'rect', 'image');

-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('cites', 'cited_by', 'replicates', 'extends', 'is_preprint_of', 'is_published_version_of', 'is_translation_of', 'supplements');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('RECEIVED', 'DETECTED', 'EXTRACTED', 'RESOLVED', 'NORMALIZED', 'MERGED', 'NEEDS_REVIEW', 'COMMITTED', 'ENRICHING', 'READY', 'FAILED_RETRYABLE', 'FAILED_FINAL');

-- CreateEnum
CREATE TYPE "AttachmentExtractionStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED_RETRYABLE', 'FAILED_FINAL');

-- CreateEnum
CREATE TYPE "ReadStatus" AS ENUM ('unread', 'reading', 'completed');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "VersionEventType" AS ENUM ('manual_save', 'auto_save', 'file_created', 'file_deleted', 'asset_uploaded', 'asset_deleted');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('urgent', 'high', 'medium', 'low', 'none');

-- CreateEnum
CREATE TYPE "TaskRecurrence" AS ENUM ('none', 'daily', 'mon_fri', 'weekly', 'monthly_day', 'monthly_week');

-- CreateEnum
CREATE TYPE "TaskReminder" AS ENUM ('none', 'at_time', 'm5', 'm10', 'm15', 'h1', 'h2', 'd1', 'd2');

-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('planned', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "CyclePhase" AS ENUM ('topic_selection', 'literature_review', 'methodology', 'data_collection', 'data_analysis', 'writing', 'review_revision', 'submission', 'custom');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('open', 'resolved');

-- CreateEnum
CREATE TYPE "StickyScope" AS ENUM ('workspace', 'project');

-- CreateEnum
CREATE TYPE "LabelType" AS ENUM ('sticky', 'cycle', 'task');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('task', 'paper', 'page', 'cycle', 'file', 'sticky', 'comment', 'collection', 'worklog');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "password" TEXT,
    "name" TEXT NOT NULL DEFAULT 'User',
    "avatar" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "google_id" TEXT,
    "github_id" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federated_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "provider_subject_id" TEXT NOT NULL,
    "email" TEXT,
    "profile_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "federated_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL DEFAULT '',
    "family_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "device_type" TEXT,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_invitations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceMemberRole" NOT NULL DEFAULT 'member',
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "invited_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "event_type" "SecurityEventType" NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "slug" TEXT,
    "avatar" TEXT DEFAULT '',
    "company_size" TEXT DEFAULT '',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "invite_code" TEXT,
    "settings" JSONB DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "WorkspaceMemberRole" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "identifier" TEXT,
    "avatar" TEXT DEFAULT '',
    "cover_image" TEXT DEFAULT '',
    "description" TEXT DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "modules" TEXT[] DEFAULT ARRAY['overview', 'tasks', 'cycles', 'pages', 'storage', 'stickies', 'collection']::TEXT[],
    "task_columns" JSONB DEFAULT '[{"id":"backlog","title":"Backlog","isDefault":true,"accentColor":"#6366F1"},{"id":"todo","title":"To Do","isDefault":true,"accentColor":"#0EA5E9"},{"id":"doing","title":"Doing","isDefault":true,"accentColor":"#F59E0B"},{"id":"review","title":"Review","isDefault":true,"accentColor":"#eab308"},{"id":"done","title":"Done","isDefault":true,"accentColor":"#22c55e"}]',
    "task_sequence" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB DEFAULT '{}',
    "workspace_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'viewer',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "is_folder" BOOLEAN NOT NULL DEFAULT false,
    "parent_id" TEXT,
    "author_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "linked_to_type" TEXT,
    "linked_to_id" TEXT,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "trashed_at" TIMESTAMP(3),
    "meta_data" JSONB,
    "size" INTEGER DEFAULT 0,
    "mime_type" TEXT DEFAULT 'application/octet-stream',
    "url" TEXT,
    "thumbnail" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_shares" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission" "FilePermission" NOT NULL DEFAULT 'view',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "type" "LabelType" NOT NULL DEFAULT 'sticky',
    "workspace_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "papers" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "year" INTEGER,
    "doi" TEXT DEFAULT '',
    "abstract" TEXT DEFAULT '',
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "item_type" TEXT DEFAULT 'journalArticle',
    "editors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "journal" TEXT DEFAULT '',
    "publication_title" TEXT DEFAULT '',
    "publication_date" TEXT DEFAULT '',
    "publisher" TEXT DEFAULT '',
    "place" TEXT DEFAULT '',
    "volume" TEXT DEFAULT '',
    "issue" TEXT DEFAULT '',
    "section" TEXT DEFAULT '',
    "part_number" TEXT DEFAULT '',
    "part_title" TEXT DEFAULT '',
    "pages" TEXT DEFAULT '',
    "series" TEXT DEFAULT '',
    "series_title" TEXT DEFAULT '',
    "series_text" TEXT DEFAULT '',
    "issn" TEXT DEFAULT '',
    "isbn" TEXT DEFAULT '',
    "pmid" TEXT DEFAULT '',
    "pmcid" TEXT DEFAULT '',
    "url" TEXT DEFAULT '',
    "type" TEXT DEFAULT '',
    "language" TEXT DEFAULT '',
    "journal_abbr" TEXT DEFAULT '',
    "short_title" TEXT DEFAULT '',
    "rights" TEXT DEFAULT '',
    "license" TEXT DEFAULT '',
    "citation_key" TEXT DEFAULT '',
    "library_catalog" TEXT DEFAULT '',
    "archive" TEXT DEFAULT '',
    "archive_location" TEXT DEFAULT '',
    "call_number" TEXT DEFAULT '',
    "accessed_at" TIMESTAMP(3),
    "extra" TEXT DEFAULT '',
    "notes" JSONB DEFAULT '[]',
    "primary_file" JSONB,
    "file_url" TEXT DEFAULT '',
    "filename" TEXT DEFAULT '',
    "mime_type" TEXT DEFAULT 'application/pdf',
    "size" INTEGER DEFAULT 0,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rag_doc_id" TEXT,
    "rag_indexed_at" TIMESTAMP(3),
    "rag_last_attempt_at" TIMESTAMP(3),
    "rag_attempts" INTEGER NOT NULL DEFAULT 0,
    "rag_error" TEXT DEFAULT '',
    "rag_status" "RagStatus",
    "workspace_id" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "collection_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_contributors" (
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
CREATE TABLE "catalog_identifiers" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "canonical_uri" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_items" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "type" TEXT NOT NULL DEFAULT 'manual',
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item_tags" (
    "id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metadata_source_records" (
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
CREATE TABLE "metadata_assertions" (
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
CREATE TABLE "catalog_item_revisions" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changes_snapshot" JSONB NOT NULL,
    "changed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_attachments" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "file_id" TEXT,
    "filename" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "file_hash" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "mime_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "attachment_type" "AttachmentType" NOT NULL DEFAULT 'supplementary',
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extraction_status" "AttachmentExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extraction_attempts" INTEGER NOT NULL DEFAULT 0,
    "extraction_started_at" TIMESTAMP(3),
    "extraction_completed_at" TIMESTAMP(3),
    "extraction_last_error" TEXT,

    CONSTRAINT "paper_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_revisions" (
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
CREATE TABLE "annotations" (
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
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "item_id" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Untitled Note',
    "content_json" JSONB,
    "content_md" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_relations" (
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
CREATE TABLE "ingestion_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "requester_id" TEXT,
    "item_id" TEXT,
    "status" "IngestionStatus" NOT NULL DEFAULT 'RECEIVED',
    "idempotency_key" TEXT,
    "input_params" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL DEFAULT '1.0.0',
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
CREATE TABLE "ingestion_stages" (
    "id" TEXT NOT NULL,
    "ingestion_run_id" TEXT NOT NULL,
    "stage_name" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "output_snapshot" JSONB,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_candidates" (
    "id" TEXT NOT NULL,
    "ingestion_run_id" TEXT NOT NULL,
    "source_provider" TEXT NOT NULL,
    "source_record_id" TEXT,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata_payload" JSONB NOT NULL,
    "raw_evidence_ref" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_decisions" (
    "id" TEXT NOT NULL,
    "ingestion_run_id" TEXT NOT NULL,
    "decision_type" TEXT NOT NULL,
    "decision_reason" TEXT NOT NULL,
    "proposed_item" JSONB NOT NULL,
    "field_decisions" JSONB,
    "duplicate_match" JSONB,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_review_cases" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ingestion_run_id" TEXT NOT NULL,
    "target_item_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "options" JSONB,
    "assigned_to_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_review_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_sequences" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "current_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_changes" (
    "id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tombstones" (
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
CREATE TABLE "user_item_states" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "read_status" "ReadStatus" NOT NULL DEFAULT 'unread',
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "rating" INTEGER DEFAULT 0,
    "last_read_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_item_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "scheduled_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "lease_expires_at" TIMESTAMP(3),
    "claimed_by" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "status_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_dedup_claims" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "claim_type" TEXT NOT NULL,
    "claim_value" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_dedup_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_searches" (
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
CREATE TABLE "full_text_indexes" (
    "id" TEXT NOT NULL,
    "attachment_id" TEXT NOT NULL,
    "page_index" INTEGER NOT NULL,
    "text_content" TEXT NOT NULL,
    "char_offset" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "full_text_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_clusters" (
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
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT DEFAULT '',
    "color" TEXT DEFAULT '#3370ff',
    "icon" TEXT DEFAULT '',
    "parent_id" TEXT,
    "workspace_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "icon" TEXT,
    "cover_image" TEXT,
    "content" JSONB,
    "status" "PageStatus" NOT NULL DEFAULT 'draft',
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "parent_page_id" TEXT,
    "main_file_id" TEXT,
    "pdf_thumbnail" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_versions" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "project_page_id" TEXT,
    "content" TEXT DEFAULT '',
    "title" TEXT DEFAULT '',
    "label" TEXT DEFAULT '',
    "saved_by_id" TEXT,
    "event_type" "VersionEventType" NOT NULL DEFAULT 'manual_save',
    "file_name" TEXT DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT DEFAULT '',
    "description" TEXT DEFAULT '',
    "column_id" TEXT NOT NULL,
    "start_date" TIMESTAMP(3),
    "due_date" TIMESTAMP(3),
    "recurrence" "TaskRecurrence" NOT NULL DEFAULT 'none',
    "reminder" "TaskReminder" NOT NULL DEFAULT 'd1',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priority" "TaskPriority" NOT NULL DEFAULT 'none',
    "estimate" DOUBLE PRECISION,
    "identifier" TEXT,
    "sequence_number" INTEGER,
    "time_spent" DOUBLE PRECISION DEFAULT 0,
    "checklists" JSONB DEFAULT '[]',
    "attachments" JSONB DEFAULT '[]',
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "project_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "assignee_id" TEXT,
    "cycle_id" TEXT,
    "parent_task_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT DEFAULT '',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "status" "CycleStatus" NOT NULL DEFAULT 'planned',
    "phase" "CyclePhase" NOT NULL DEFAULT 'custom',
    "milestones" JSONB DEFAULT '[]',
    "deliverables" JSONB DEFAULT '[]',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "order" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "stats_at_completion" JSONB DEFAULT '{"totalTasks":0,"completedTasks":0,"completionPercentage":0}',
    "project_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worklogs" (
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

-- CreateTable
CREATE TABLE "page_comments" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "project_page_id" TEXT,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "line" INTEGER,
    "line_end" INTEGER,
    "status" "CommentStatus" NOT NULL DEFAULT 'open',
    "replies" JSONB DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "reactions" JSONB DEFAULT '[]',
    "replies" JSONB DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stickies" (
    "id" TEXT NOT NULL,
    "title" TEXT DEFAULT '',
    "content" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'yellow-1',
    "scope" "StickyScope" NOT NULL DEFAULT 'workspace',
    "position_x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stickies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chats" (
    "id" TEXT NOT NULL,
    "workspace_slug" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "page_id" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "summary" TEXT DEFAULT '',
    "key_facts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "open_questions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "document_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "sources" JSONB DEFAULT '[]',
    "widgets" JSONB DEFAULT '[]',
    "selection_context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" TEXT NOT NULL,
    "entity_type" "EntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "field" TEXT,
    "old_value" TEXT,
    "new_value" TEXT,
    "old_identifier" TEXT,
    "new_identifier" TEXT,
    "actor_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'zotero',
    "account_name" TEXT,
    "account_type" TEXT DEFAULT 'user',
    "zotero_user_id" TEXT,
    "encrypted_api_key" TEXT NOT NULL,
    "key_iv" TEXT NOT NULL,
    "key_tag" TEXT NOT NULL,
    "scopes" JSONB DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_bindings" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "remote_library_type" TEXT NOT NULL DEFAULT 'user',
    "remote_library_id" TEXT NOT NULL,
    "last_sync_version" BIGINT NOT NULL DEFAULT 0,
    "last_sync_at" TIMESTAMP(3),
    "sync_status" TEXT NOT NULL DEFAULT 'idle',
    "sync_direction" TEXT NOT NULL DEFAULT 'read_only',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_item_bindings" (
    "id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "remote_key" TEXT NOT NULL,
    "remote_version" BIGINT NOT NULL DEFAULT 0,
    "base_snapshot" JSONB,
    "raw_payload" JSONB,
    "sync_state" TEXT NOT NULL DEFAULT 'synced',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_item_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_sync_runs" (
    "id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'pull',
    "version_before" BIGINT NOT NULL DEFAULT 0,
    "version_after" BIGINT NOT NULL DEFAULT 0,
    "items_created" INTEGER NOT NULL DEFAULT 0,
    "items_updated" INTEGER NOT NULL DEFAULT 0,
    "items_deleted" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "zotero_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_sync_failures" (
    "id" TEXT NOT NULL,
    "sync_run_id" TEXT,
    "binding_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "remote_key" TEXT,
    "entity_id" TEXT,
    "error_message" TEXT NOT NULL,
    "error_details" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'retryable',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_sync_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_policies" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "changed_by" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_previews" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "canonical_metadata" JSONB NOT NULL,
    "metadata_digest" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capture_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_deleted_at_idx" ON "users"("status", "deleted_at");

-- CreateIndex
CREATE INDEX "users_google_id_idx" ON "users"("google_id");

-- CreateIndex
CREATE INDEX "users_github_id_idx" ON "users"("github_id");

-- CreateIndex
CREATE INDEX "federated_identities_user_id_idx" ON "federated_identities"("user_id");

-- CreateIndex
CREATE INDEX "federated_identities_email_idx" ON "federated_identities"("email");

-- CreateIndex
CREATE UNIQUE INDEX "federated_identities_provider_provider_subject_id_key" ON "federated_identities"("provider", "provider_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "federated_identities_user_id_provider_key" ON "federated_identities"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_is_revoked_expires_at_idx" ON "refresh_tokens"("user_id", "is_revoked", "expires_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_expires_at_idx" ON "refresh_tokens"("user_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invitations_token_key" ON "workspace_invitations"("token");

-- CreateIndex
CREATE INDEX "workspace_invitations_workspace_id_status_idx" ON "workspace_invitations"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "workspace_invitations_email_status_idx" ON "workspace_invitations"("email", "status");

-- CreateIndex
CREATE INDEX "workspace_invitations_token_idx" ON "workspace_invitations"("token");

-- CreateIndex
CREATE INDEX "security_audit_logs_actor_id_created_at_idx" ON "security_audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "security_audit_logs_event_type_created_at_idx" ON "security_audit_logs"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "security_audit_logs_target_type_target_id_idx" ON "security_audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_url_key" ON "workspaces"("url");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_invite_code_key" ON "workspaces"("invite_code");

-- CreateIndex
CREATE INDEX "workspaces_created_by_id_idx" ON "workspaces"("created_by_id");

-- CreateIndex
CREATE INDEX "workspaces_url_idx" ON "workspaces"("url");

-- CreateIndex
CREATE INDEX "workspaces_slug_idx" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_invite_code_idx" ON "workspaces"("invite_code");

-- CreateIndex
CREATE INDEX "workspaces_deleted_at_idx" ON "workspaces"("deleted_at");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_role_idx" ON "workspace_members"("workspace_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_is_active_deleted_at_idx" ON "projects"("workspace_id", "is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "projects_created_by_id_idx" ON "projects"("created_by_id");

-- CreateIndex
CREATE INDEX "projects_lead_id_idx" ON "projects"("lead_id");

-- CreateIndex
CREATE INDEX "projects_deleted_at_idx" ON "projects"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_identifier_key" ON "projects"("workspace_id", "identifier");

-- CreateIndex
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

-- CreateIndex
CREATE INDEX "project_members_project_id_role_idx" ON "project_members"("project_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "files_workspace_id_parent_id_trashed_at_idx" ON "files"("workspace_id", "parent_id", "trashed_at");

-- CreateIndex
CREATE INDEX "files_workspace_id_is_folder_trashed_at_idx" ON "files"("workspace_id", "is_folder", "trashed_at");

-- CreateIndex
CREATE INDEX "files_linked_to_id_linked_to_type_idx" ON "files"("linked_to_id", "linked_to_type");

-- CreateIndex
CREATE INDEX "files_author_id_trashed_at_idx" ON "files"("author_id", "trashed_at");

-- CreateIndex
CREATE INDEX "files_trashed_at_idx" ON "files"("trashed_at");

-- CreateIndex
CREATE INDEX "file_shares_user_id_idx" ON "file_shares"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_shares_file_id_user_id_key" ON "file_shares"("file_id", "user_id");

-- CreateIndex
CREATE INDEX "labels_workspace_id_name_type_idx" ON "labels"("workspace_id", "name", "type");

-- CreateIndex
CREATE INDEX "papers_workspace_id_collection_id_deleted_at_created_at_idx" ON "papers"("workspace_id", "collection_id", "deleted_at", "created_at");

-- CreateIndex
CREATE INDEX "papers_workspace_id_deleted_at_idx" ON "papers"("workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX "papers_workspace_id_rag_status_idx" ON "papers"("workspace_id", "rag_status");

-- CreateIndex
CREATE INDEX "papers_doi_idx" ON "papers"("doi");

-- CreateIndex
CREATE INDEX "papers_citation_key_idx" ON "papers"("citation_key");

-- CreateIndex
CREATE INDEX "catalog_contributors_catalog_item_id_order_index_idx" ON "catalog_contributors"("catalog_item_id", "order_index");

-- CreateIndex
CREATE INDEX "catalog_contributors_full_name_idx" ON "catalog_contributors"("full_name");

-- CreateIndex
CREATE INDEX "catalog_identifiers_catalog_item_id_type_idx" ON "catalog_identifiers"("catalog_item_id", "type");

-- CreateIndex
CREATE INDEX "catalog_identifiers_type_value_idx" ON "catalog_identifiers"("type", "value");

-- CreateIndex
CREATE INDEX "catalog_identifiers_canonical_uri_idx" ON "catalog_identifiers"("canonical_uri");

-- CreateIndex
CREATE INDEX "collection_items_collection_id_idx" ON "collection_items"("collection_id");

-- CreateIndex
CREATE INDEX "collection_items_catalog_item_id_idx" ON "collection_items"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_items_collection_id_catalog_item_id_key" ON "collection_items"("collection_id", "catalog_item_id");

-- CreateIndex
CREATE INDEX "catalog_tags_workspace_id_name_idx" ON "catalog_tags"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_tags_workspace_id_name_key" ON "catalog_tags"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "catalog_item_tags_tag_id_idx" ON "catalog_item_tags"("tag_id");

-- CreateIndex
CREATE INDEX "catalog_item_tags_catalog_item_id_idx" ON "catalog_item_tags"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_tags_tag_id_catalog_item_id_key" ON "catalog_item_tags"("tag_id", "catalog_item_id");

-- CreateIndex
CREATE INDEX "metadata_source_records_catalog_item_id_source_provider_idx" ON "metadata_source_records"("catalog_item_id", "source_provider");

-- CreateIndex
CREATE INDEX "metadata_source_records_snapshot_hash_idx" ON "metadata_source_records"("snapshot_hash");

-- CreateIndex
CREATE INDEX "metadata_assertions_catalog_item_id_field_idx" ON "metadata_assertions"("catalog_item_id", "field");

-- CreateIndex
CREATE INDEX "metadata_assertions_is_user_override_idx" ON "metadata_assertions"("is_user_override");

-- CreateIndex
CREATE INDEX "catalog_item_revisions_catalog_item_id_version_idx" ON "catalog_item_revisions"("catalog_item_id", "version");

-- CreateIndex
CREATE INDEX "paper_attachments_paperId_idx" ON "paper_attachments"("paperId");

-- CreateIndex
CREATE INDEX "paper_attachments_file_id_idx" ON "paper_attachments"("file_id");

-- CreateIndex
CREATE INDEX "paper_attachments_extraction_status_idx" ON "paper_attachments"("extraction_status");

-- CreateIndex
CREATE INDEX "attachment_revisions_attachment_id_revision_number_idx" ON "attachment_revisions"("attachment_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_revisions_attachment_id_revision_number_key" ON "attachment_revisions"("attachment_id", "revision_number");

-- CreateIndex
CREATE INDEX "annotations_attachment_id_page_index_idx" ON "annotations"("attachment_id", "page_index");

-- CreateIndex
CREATE INDEX "annotations_attachment_id_deleted_at_idx" ON "annotations"("attachment_id", "deleted_at");

-- CreateIndex
CREATE INDEX "notes_workspace_id_item_id_created_at_idx" ON "notes"("workspace_id", "item_id", "created_at");

-- CreateIndex
CREATE INDEX "notes_workspace_id_deleted_at_idx" ON "notes"("workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX "item_relations_workspace_id_source_item_id_idx" ON "item_relations"("workspace_id", "source_item_id");

-- CreateIndex
CREATE INDEX "item_relations_target_item_id_idx" ON "item_relations"("target_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_relations_source_item_id_target_item_id_relation_type_key" ON "item_relations"("source_item_id", "target_item_id", "relation_type");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_idempotency_key_key" ON "ingestion_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "ingestion_runs_workspace_id_status_idx" ON "ingestion_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ingestion_runs_input_hash_idx" ON "ingestion_runs"("input_hash");

-- CreateIndex
CREATE INDEX "ingestion_stages_ingestion_run_id_stage_name_idx" ON "ingestion_stages"("ingestion_run_id", "stage_name");

-- CreateIndex
CREATE INDEX "ingestion_candidates_ingestion_run_id_source_provider_idx" ON "ingestion_candidates"("ingestion_run_id", "source_provider");

-- CreateIndex
CREATE INDEX "ingestion_decisions_ingestion_run_id_decision_type_idx" ON "ingestion_decisions"("ingestion_run_id", "decision_type");

-- CreateIndex
CREATE INDEX "ingestion_review_cases_workspace_id_status_idx" ON "ingestion_review_cases"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ingestion_review_cases_ingestion_run_id_idx" ON "ingestion_review_cases"("ingestion_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_sequences_workspace_id_key" ON "sync_sequences"("workspace_id");

-- CreateIndex
CREATE INDEX "library_changes_workspace_id_seq_idx" ON "library_changes"("workspace_id", "seq");

-- CreateIndex
CREATE INDEX "library_changes_workspace_id_entity_type_entity_id_idx" ON "library_changes"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "library_changes_workspace_id_seq_key" ON "library_changes"("workspace_id", "seq");

-- CreateIndex
CREATE INDEX "tombstones_workspace_id_deleted_at_idx" ON "tombstones"("workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX "tombstones_workspace_id_seq_idx" ON "tombstones"("workspace_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "tombstones_workspace_id_entity_type_entity_id_key" ON "tombstones"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "user_item_states_user_id_read_status_idx" ON "user_item_states"("user_id", "read_status");

-- CreateIndex
CREATE INDEX "user_item_states_item_id_idx" ON "user_item_states"("item_id");

-- CreateIndex
CREATE INDEX "user_item_states_user_id_is_favorite_idx" ON "user_item_states"("user_id", "is_favorite");

-- CreateIndex
CREATE INDEX "user_item_states_user_id_last_read_at_idx" ON "user_item_states"("user_id", "last_read_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_item_states_user_id_item_id_key" ON "user_item_states"("user_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_scheduled_at_idx" ON "outbox_events"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_lease_expires_at_idx" ON "outbox_events"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_workspace_id_status_idx" ON "outbox_events"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "idempotency_records_idempotency_key_workspace_id_idx" ON "idempotency_records"("idempotency_key", "workspace_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_workspace_id_idempotency_key_key" ON "idempotency_records"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "library_dedup_claims_workspace_id_claim_type_claim_value_idx" ON "library_dedup_claims"("workspace_id", "claim_type", "claim_value");

-- CreateIndex
CREATE INDEX "library_dedup_claims_catalog_item_id_idx" ON "library_dedup_claims"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "library_dedup_claims_workspace_id_claim_type_claim_value_key" ON "library_dedup_claims"("workspace_id", "claim_type", "claim_value");

-- CreateIndex
CREATE INDEX "saved_searches_workspace_id_user_id_idx" ON "saved_searches"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "full_text_indexes_attachment_id_page_index_idx" ON "full_text_indexes"("attachment_id", "page_index");

-- CreateIndex
CREATE UNIQUE INDEX "full_text_indexes_attachment_id_page_index_key" ON "full_text_indexes"("attachment_id", "page_index");

-- CreateIndex
CREATE INDEX "duplicate_clusters_workspace_id_status_idx" ON "duplicate_clusters"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "collections_workspace_id_parent_id_created_at_idx" ON "collections"("workspace_id", "parent_id", "created_at");

-- CreateIndex
CREATE INDEX "pages_project_id_parent_page_id_rank_idx" ON "pages"("project_id", "parent_page_id", "rank");

-- CreateIndex
CREATE INDEX "pages_project_id_status_deleted_at_idx" ON "pages"("project_id", "status", "deleted_at");

-- CreateIndex
CREATE INDEX "pages_workspace_id_project_id_deleted_at_idx" ON "pages"("workspace_id", "project_id", "deleted_at");

-- CreateIndex
CREATE INDEX "pages_parent_page_id_deleted_at_idx" ON "pages"("parent_page_id", "deleted_at");

-- CreateIndex
CREATE INDEX "pages_author_id_idx" ON "pages"("author_id");

-- CreateIndex
CREATE INDEX "pages_deleted_at_idx" ON "pages"("deleted_at");

-- CreateIndex
CREATE INDEX "page_versions_page_id_created_at_idx" ON "page_versions"("page_id", "created_at");

-- CreateIndex
CREATE INDEX "page_versions_project_page_id_idx" ON "page_versions"("project_page_id");

-- CreateIndex
CREATE INDEX "tasks_project_id_column_id_rank_idx" ON "tasks"("project_id", "column_id", "rank");

-- CreateIndex
CREATE INDEX "tasks_project_id_column_id_deleted_at_rank_idx" ON "tasks"("project_id", "column_id", "deleted_at", "rank");

-- CreateIndex
CREATE INDEX "tasks_project_id_parent_task_id_rank_idx" ON "tasks"("project_id", "parent_task_id", "rank");

-- CreateIndex
CREATE INDEX "tasks_project_id_completed_deleted_at_idx" ON "tasks"("project_id", "completed", "deleted_at");

-- CreateIndex
CREATE INDEX "tasks_project_id_assignee_id_due_date_idx" ON "tasks"("project_id", "assignee_id", "due_date");

-- CreateIndex
CREATE INDEX "tasks_project_id_identifier_idx" ON "tasks"("project_id", "identifier");

-- CreateIndex
CREATE INDEX "tasks_cycle_id_deleted_at_idx" ON "tasks"("cycle_id", "deleted_at");

-- CreateIndex
CREATE INDEX "tasks_deleted_at_idx" ON "tasks"("deleted_at");

-- CreateIndex
CREATE INDEX "cycles_project_id_status_deleted_at_idx" ON "cycles"("project_id", "status", "deleted_at");

-- CreateIndex
CREATE INDEX "cycles_project_id_order_idx" ON "cycles"("project_id", "order");

-- CreateIndex
CREATE INDEX "cycles_deleted_at_idx" ON "cycles"("deleted_at");

-- CreateIndex
CREATE INDEX "worklogs_project_id_date_idx" ON "worklogs"("project_id", "date");

-- CreateIndex
CREATE INDEX "worklogs_user_id_date_idx" ON "worklogs"("user_id", "date");

-- CreateIndex
CREATE INDEX "worklogs_project_id_user_id_date_idx" ON "worklogs"("project_id", "user_id", "date");

-- CreateIndex
CREATE INDEX "worklogs_task_id_idx" ON "worklogs"("task_id");

-- CreateIndex
CREATE INDEX "page_comments_page_id_status_idx" ON "page_comments"("page_id", "status");

-- CreateIndex
CREATE INDEX "page_comments_author_id_idx" ON "page_comments"("author_id");

-- CreateIndex
CREATE INDEX "task_comments_task_id_idx" ON "task_comments"("task_id");

-- CreateIndex
CREATE INDEX "task_comments_author_id_idx" ON "task_comments"("author_id");

-- CreateIndex
CREATE INDEX "stickies_workspace_id_user_id_scope_order_idx" ON "stickies"("workspace_id", "user_id", "scope", "order");

-- CreateIndex
CREATE INDEX "stickies_project_id_user_id_scope_order_idx" ON "stickies"("project_id", "user_id", "scope", "order");

-- CreateIndex
CREATE INDEX "stickies_user_id_idx" ON "stickies"("user_id");

-- CreateIndex
CREATE INDEX "ai_chats_workspace_slug_user_id_updated_at_idx" ON "ai_chats"("workspace_slug", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "ai_chats_project_id_user_id_updated_at_idx" ON "ai_chats"("project_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "ai_chats_page_id_user_id_idx" ON "ai_chats"("page_id", "user_id");

-- CreateIndex
CREATE INDEX "ai_chats_user_id_idx" ON "ai_chats"("user_id");

-- CreateIndex
CREATE INDEX "ai_messages_chat_id_created_at_idx" ON "ai_messages"("chat_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_workspace_id_created_at_idx" ON "activity_events"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_workspace_id_entity_type_created_at_idx" ON "activity_events"("workspace_id", "entity_type", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_project_id_created_at_idx" ON "activity_events"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_entity_type_entity_id_created_at_idx" ON "activity_events"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_actor_id_created_at_idx" ON "activity_events"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "zotero_connections_workspace_id_status_idx" ON "zotero_connections"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_connections_workspace_id_zotero_user_id_key" ON "zotero_connections"("workspace_id", "zotero_user_id");

-- CreateIndex
CREATE INDEX "zotero_bindings_connection_id_idx" ON "zotero_bindings"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_bindings_workspace_id_remote_library_type_remote_lib_key" ON "zotero_bindings"("workspace_id", "remote_library_type", "remote_library_id");

-- CreateIndex
CREATE INDEX "zotero_item_bindings_workspace_id_entity_type_entity_id_idx" ON "zotero_item_bindings"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_item_bindings_binding_id_remote_key_key" ON "zotero_item_bindings"("binding_id", "remote_key");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_item_bindings_binding_id_entity_type_entity_id_key" ON "zotero_item_bindings"("binding_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "zotero_sync_runs_binding_id_started_at_idx" ON "zotero_sync_runs"("binding_id", "started_at");

-- CreateIndex
CREATE INDEX "zotero_sync_failures_binding_id_status_idx" ON "zotero_sync_failures"("binding_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_policies_provider_key" ON "integration_policies"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "capture_previews_token_hash_key" ON "capture_previews"("token_hash");

-- CreateIndex
CREATE INDEX "capture_previews_workspace_id_expires_at_idx" ON "capture_previews"("workspace_id", "expires_at");

-- CreateIndex
CREATE INDEX "capture_previews_token_hash_idx" ON "capture_previews"("token_hash");

-- AddForeignKey
ALTER TABLE "federated_identities" ADD CONSTRAINT "federated_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "papers" ADD CONSTRAINT "papers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "papers" ADD CONSTRAINT "papers_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "papers" ADD CONSTRAINT "papers_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_contributors" ADD CONSTRAINT "catalog_contributors_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_identifiers" ADD CONSTRAINT "catalog_identifiers_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_tags" ADD CONSTRAINT "catalog_tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_tags" ADD CONSTRAINT "catalog_item_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "catalog_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_tags" ADD CONSTRAINT "catalog_item_tags_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metadata_source_records" ADD CONSTRAINT "metadata_source_records_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metadata_assertions" ADD CONSTRAINT "metadata_assertions_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_revisions" ADD CONSTRAINT "catalog_item_revisions_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_attachments" ADD CONSTRAINT "paper_attachments_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_attachments" ADD CONSTRAINT "paper_attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_revisions" ADD CONSTRAINT "attachment_revisions_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "paper_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "paper_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_target_item_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "papers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_stages" ADD CONSTRAINT "ingestion_stages_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_candidates" ADD CONSTRAINT "ingestion_candidates_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_decisions" ADD CONSTRAINT "ingestion_decisions_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_review_cases" ADD CONSTRAINT "ingestion_review_cases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_review_cases" ADD CONSTRAINT "ingestion_review_cases_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sequences" ADD CONSTRAINT "sync_sequences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_changes" ADD CONSTRAINT "library_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tombstones" ADD CONSTRAINT "tombstones_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_item_states" ADD CONSTRAINT "user_item_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_item_states" ADD CONSTRAINT "user_item_states_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_dedup_claims" ADD CONSTRAINT "library_dedup_claims_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_dedup_claims" ADD CONSTRAINT "library_dedup_claims_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "full_text_indexes" ADD CONSTRAINT "full_text_indexes_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "paper_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_clusters" ADD CONSTRAINT "duplicate_clusters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_page_id_fkey" FOREIGN KEY ("parent_page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_main_file_id_fkey" FOREIGN KEY ("main_file_id") REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stickies" ADD CONSTRAINT "stickies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stickies" ADD CONSTRAINT "stickies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stickies" ADD CONSTRAINT "stickies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chats" ADD CONSTRAINT "ai_chats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "ai_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_connections" ADD CONSTRAINT "zotero_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_connections" ADD CONSTRAINT "zotero_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_bindings" ADD CONSTRAINT "zotero_bindings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "zotero_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_bindings" ADD CONSTRAINT "zotero_bindings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_item_bindings" ADD CONSTRAINT "zotero_item_bindings_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "zotero_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_item_bindings" ADD CONSTRAINT "zotero_item_bindings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_runs" ADD CONSTRAINT "zotero_sync_runs_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "zotero_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_runs" ADD CONSTRAINT "zotero_sync_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_failures" ADD CONSTRAINT "zotero_sync_failures_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "zotero_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_failures" ADD CONSTRAINT "zotero_sync_failures_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "zotero_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_failures" ADD CONSTRAINT "zotero_sync_failures_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_previews" ADD CONSTRAINT "capture_previews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_previews" ADD CONSTRAINT "capture_previews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
