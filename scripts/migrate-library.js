const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const c = new Client({
    connectionString: 'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public',
  });
  await c.connect();

  console.log('Connected to PostgreSQL database.');

  await c.query('BEGIN');
  try {
    // 1. Create Enums if not exist
    console.log('Step 1: Enums...');
    await c.query(`
      DO $$ BEGIN
        CREATE TYPE "IngestionStage" AS ENUM ('IDENTIFY', 'EXTRACT', 'NORMALIZE', 'ENRICH', 'RECONCILE', 'MATCH', 'COMMIT');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    await c.query(`
      DO $$ BEGIN
        CREATE TYPE "TagType" AS ENUM ('manual', 'automatic', 'ai');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    await c.query(`
      DO $$ BEGIN
        ALTER TYPE "AnnotationType" ADD VALUE 'ink';
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    // IngestionStatus update
    await c.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IngestionStatus_new') THEN
          CREATE TYPE "IngestionStatus_new" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED', 'STALLED');
        END IF;
      END $$;
    `);

    await c.query(`
      ALTER TABLE "ingestion_runs" ALTER COLUMN "status" DROP DEFAULT;
      ALTER TABLE "ingestion_runs" ALTER COLUMN "status" TYPE "IngestionStatus_new" USING ("status"::text::"IngestionStatus_new");
      DROP TYPE IF EXISTS "IngestionStatus";
      ALTER TYPE "IngestionStatus_new" RENAME TO "IngestionStatus";
      ALTER TABLE "ingestion_runs" ALTER COLUMN "status" SET DEFAULT 'PENDING';
    `);

    // 2. Drop old foreign keys to papers
    console.log('Step 2: Dropping old foreign keys to papers...');
    const dropFks = [
      'ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_item_id_fkey"',
      'ALTER TABLE "collection_items" DROP CONSTRAINT IF EXISTS "collection_items_item_id_fkey"',
      'ALTER TABLE "contributors" DROP CONSTRAINT IF EXISTS "contributors_item_id_fkey"',
      'ALTER TABLE "identifiers" DROP CONSTRAINT IF EXISTS "identifiers_item_id_fkey"',
      'ALTER TABLE "ingestion_candidates" DROP CONSTRAINT IF EXISTS "ingestion_candidates_ingestion_run_id_fkey"',
      'ALTER TABLE "ingestion_decisions" DROP CONSTRAINT IF EXISTS "ingestion_decisions_ingestion_run_id_fkey"',
      'ALTER TABLE "ingestion_review_cases" DROP CONSTRAINT IF EXISTS "ingestion_review_cases_ingestion_run_id_fkey"',
      'ALTER TABLE "ingestion_runs" DROP CONSTRAINT IF EXISTS "ingestion_runs_item_id_fkey"',
      'ALTER TABLE "ingestion_stages" DROP CONSTRAINT IF EXISTS "ingestion_stages_ingestion_run_id_fkey"',
      'ALTER TABLE "item_relations" DROP CONSTRAINT IF EXISTS "item_relations_source_item_id_fkey"',
      'ALTER TABLE "item_relations" DROP CONSTRAINT IF EXISTS "item_relations_target_item_id_fkey"',
      'ALTER TABLE "item_revisions" DROP CONSTRAINT IF EXISTS "item_revisions_item_id_fkey"',
      'ALTER TABLE "item_tags" DROP CONSTRAINT IF EXISTS "item_tags_item_id_fkey"',
      'ALTER TABLE "metadata_source_records" DROP CONSTRAINT IF EXISTS "metadata_source_records_item_id_fkey"',
      'ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_item_id_fkey"',
      'ALTER TABLE "user_item_states" DROP CONSTRAINT IF EXISTS "user_item_states_item_id_fkey"',
    ];
    for (const q of dropFks) {
      await c.query(q);
    }

    // 3. Drop obsolete indexes
    console.log('Step 3: Dropping obsolete indexes...');
    const dropIdxs = [
      'DROP INDEX IF EXISTS "annotations_attachment_id_page_index_idx"',
      'DROP INDEX IF EXISTS "annotations_author_id_idx"',
      'DROP INDEX IF EXISTS "attachments_item_id_type_idx"',
      'DROP INDEX IF EXISTS "collection_items_collection_id_item_id_key"',
      'DROP INDEX IF EXISTS "collections_project_id_parent_id_created_at_idx"',
      'DROP INDEX IF EXISTS "collections_user_id_parent_id_created_at_idx"',
      'DROP INDEX IF EXISTS "full_text_indexes_attachment_id_page_index_idx"',
      'DROP INDEX IF EXISTS "idempotency_records_user_id_idempotency_key_idx"',
      'DROP INDEX IF EXISTS "ingestion_runs_project_id_status_idx"',
      'DROP INDEX IF EXISTS "ingestion_runs_user_id_status_idx"',
      'DROP INDEX IF EXISTS "item_tags_tag_id_item_id_key"',
      'DROP INDEX IF EXISTS "notes_item_id_idx"',
      'DROP INDEX IF EXISTS "notes_project_id_idx"',
      'DROP INDEX IF EXISTS "notes_user_id_idx"',
      'DROP INDEX IF EXISTS "saved_searches_project_id_idx"',
      'DROP INDEX IF EXISTS "saved_searches_user_id_idx"',
      'DROP INDEX IF EXISTS "tags_project_id_idx"',
      'DROP INDEX IF EXISTS "tags_user_id_name_key"',
      'DROP INDEX IF EXISTS "user_item_states_user_id_item_id_key"',
    ];
    for (const q of dropIdxs) {
      await c.query(q);
    }

    // 4. Alter existing tables
    console.log('Step 4: Altering existing tables...');
    await c.query(`
      ALTER TABLE "annotations" ADD COLUMN IF NOT EXISTS "page_label" TEXT DEFAULT '';
      ALTER TABLE "attachment_revisions" ADD COLUMN IF NOT EXISTS "file_id" UUID;
      ALTER TABLE "attachment_revisions" ALTER COLUMN "size_bytes" SET DATA TYPE BIGINT;
      ALTER TABLE "attachments" DROP COLUMN IF EXISTS "extracted_text";
      ALTER TABLE "attachments" DROP COLUMN IF EXISTS "name";
      ALTER TABLE "attachments" DROP COLUMN IF EXISTS "type";
      ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "page_count" INTEGER;
      ALTER TABLE "attachments" ALTER COLUMN "size" SET DATA TYPE BIGINT;
    `);

    // collection_items primary key
    await c.query(`
      ALTER TABLE "collection_items" DROP CONSTRAINT IF EXISTS "collection_items_pkey";
      ALTER TABLE "collection_items" DROP COLUMN IF EXISTS "id";
      ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_pkey" PRIMARY KEY ("collection_id", "item_id");
    `);

    // collections sort_order & created_by_id
    await c.query(`
      ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE "collections" ALTER COLUMN "created_by_id" TYPE UUID USING ("created_by_id"::uuid);
    `);

    // contributors
    await c.query(`
      ALTER TABLE "contributors" ADD COLUMN IF NOT EXISTS "field_mode" INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE "contributors" ADD COLUMN IF NOT EXISTS "orcid" VARCHAR(19);
    `);

    // full_text_indexes
    await c.query(`
      ALTER TABLE "full_text_indexes" DROP CONSTRAINT IF EXISTS "full_text_indexes_pkey";
      ALTER TABLE "full_text_indexes" DROP COLUMN IF EXISTS "id";
      ALTER TABLE "full_text_indexes" ADD CONSTRAINT "full_text_indexes_pkey" PRIMARY KEY ("attachment_id", "page_index");
    `);

    // idempotency_records
    await c.query(`
      ALTER TABLE "idempotency_records" DROP COLUMN IF EXISTS "response";
    `);

    // ingestion_runs
    await c.query(`
      ALTER TABLE "ingestion_runs" DROP COLUMN IF EXISTS "requester_id";
      ALTER TABLE "ingestion_runs" ADD COLUMN IF NOT EXISTS "current_stage" "IngestionStage";
      ALTER TABLE "ingestion_runs" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMPTZ(6);
      ALTER TABLE "ingestion_runs" ADD COLUMN IF NOT EXISTS "review_data" JSONB;
      ALTER TABLE "ingestion_runs" ADD COLUMN IF NOT EXISTS "trace_id" VARCHAR(64);
      ALTER TABLE "ingestion_runs" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE "ingestion_runs" ALTER COLUMN "input_hash" SET DATA TYPE VARCHAR(64);
      ALTER TABLE "ingestion_runs" ALTER COLUMN "idempotency_key" SET DATA TYPE VARCHAR(128);
      ALTER TABLE "ingestion_runs" ALTER COLUMN "contract_version" SET DATA TYPE VARCHAR(16);
      ALTER TABLE "ingestion_runs" ALTER COLUMN "pipeline_version" SET DATA TYPE VARCHAR(16);
      ALTER TABLE "ingestion_runs" ALTER COLUMN "status" SET DEFAULT 'PENDING';
    `);

    // item_tags
    await c.query(`
      ALTER TABLE "item_tags" DROP CONSTRAINT IF EXISTS "item_tags_pkey";
      ALTER TABLE "item_tags" DROP COLUMN IF EXISTS "id";
      ALTER TABLE "item_tags" ADD COLUMN IF NOT EXISTS "type" "TagType" NOT NULL DEFAULT 'manual';
      ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_pkey" PRIMARY KEY ("tag_id", "item_id");
    `);

    // pages
    await c.query(`
      ALTER TABLE "pages" DROP COLUMN IF EXISTS "labels";
    `);

    // saved_searches
    await c.query(`
      ALTER TABLE "saved_searches" DROP COLUMN IF EXISTS "filters";
      ALTER TABLE "saved_searches" ALTER COLUMN "conditions" SET NOT NULL;
    `);

    // sync_sequences
    await c.query(`
      ALTER TABLE "sync_sequences" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);

    // tags
    await c.query(`
      ALTER TABLE "tags" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
      ALTER TABLE "tags" ADD COLUMN IF NOT EXISTS "shortcut" INTEGER;
      ALTER TABLE "tags" ALTER COLUMN "color" SET DEFAULT '#3b82f6';
      ALTER TABLE "tags" DROP COLUMN IF EXISTS "type";
      ALTER TABLE "tags" ADD COLUMN "type" "TagType" NOT NULL DEFAULT 'manual';
    `);

    // user_item_states
    await c.query(`
      ALTER TABLE "user_item_states" DROP CONSTRAINT IF EXISTS "user_item_states_pkey";
      ALTER TABLE "user_item_states" DROP COLUMN IF EXISTS "id";
      ALTER TABLE "user_item_states" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE "user_item_states" ADD COLUMN IF NOT EXISTS "is_starred" BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE "user_item_states" ADD CONSTRAINT "user_item_states_pkey" PRIMARY KEY ("user_id", "item_id");
    `);

    // 5. Create new tables
    console.log('Step 5: Creating new tables...');
    await c.query(`
      CREATE TABLE IF NOT EXISTS "items" (
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
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS "item_metadata" (
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
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS "retractions" (
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
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS "user_publications" (
        "user_id" UUID NOT NULL,
        "item_id" UUID NOT NULL,
        "contributor_id" UUID,
        "is_public" BOOLEAN NOT NULL DEFAULT false,
        "open_access_license" TEXT,
        "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "user_publications_pkey" PRIMARY KEY ("user_id","item_id")
      );
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS "item_field_mappings" (
        "item_type" VARCHAR(64) NOT NULL,
        "base_field" VARCHAR(64) NOT NULL,
        "field_key" VARCHAR(64) NOT NULL,
        "field_label" VARCHAR(128),
        "order_index" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "item_field_mappings_pkey" PRIMARY KEY ("item_type","base_field")
      );
    `);

    // 6. Migrate data from papers to items if papers table exists
    console.log('Step 6: Migrating papers to items...');
    const papersCheck = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='papers'");
    if (papersCheck.rows.length > 0) {
      await c.query(`
        INSERT INTO "items" (
          "id", "title", "type", "year", "citation_key", "doi", "publication_title", "abstract", "url",
          "metadata", "user_id", "project_id", "version", "deleted_at", "created_at", "updated_at",
          "has_file", "attachment_count", "note_count", "first_author"
        )
        SELECT
          p.id,
          p.title,
          COALESCE(p.item_type, 'journalArticle'),
          p.year,
          p.citation_key,
          p.doi,
          p.publication_title,
          p.abstract,
          p.url,
          '{}'::jsonb,
          p.user_id,
          p.project_id,
          COALESCE(p.version, 1),
          p.deleted_at,
          p.created_at,
          p.updated_at,
          false,
          0,
          0,
          NULL
        FROM "papers" p
        ON CONFLICT ("id") DO NOTHING;
      `);
      console.log('Migrated papers into items.');
    }

    // 7. Drop obsolete tables and enum
    console.log('Step 7: Dropping obsolete tables...');
    const dropTables = [
      'DROP TABLE IF EXISTS "capture_previews"',
      'DROP TABLE IF EXISTS "identifiers"',
      'DROP TABLE IF EXISTS "ingestion_candidates"',
      'DROP TABLE IF EXISTS "ingestion_decisions"',
      'DROP TABLE IF EXISTS "ingestion_review_cases"',
      'DROP TABLE IF EXISTS "ingestion_stages"',
      'DROP TABLE IF EXISTS "item_revisions"',
      'DROP TABLE IF EXISTS "metadata_source_records"',
      'DROP TABLE IF EXISTS "papers"',
      'DROP TABLE IF EXISTS "retraction_records"',
      'DROP TYPE IF EXISTS "RagStatus"',
    ];
    for (const q of dropTables) {
      await c.query(q);
    }

    // 8. Create Indexes
    console.log('Step 8: Creating indexes...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS "items_project_id_deleted_at_idx" ON "items"("project_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "items_user_id_deleted_at_year_created_at_idx" ON "items"("user_id", "deleted_at", "year" DESC, "created_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "items_user_id_type_idx" ON "items"("user_id", "type")',
      'CREATE INDEX IF NOT EXISTS "items_user_id_has_file_deleted_at_idx" ON "items"("user_id", "has_file", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "items_doi_idx" ON "items"("doi")',
      'CREATE INDEX IF NOT EXISTS "items_citation_key_idx" ON "items"("citation_key")',
      'CREATE INDEX IF NOT EXISTS "items_publication_title_idx" ON "items"("publication_title")',
      'CREATE INDEX IF NOT EXISTS "items_metadata_idx" ON "items" USING GIN ("metadata")',
      'CREATE INDEX IF NOT EXISTS "item_metadata_item_id_source_provider_created_at_idx" ON "item_metadata"("item_id", "source_provider", "created_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "item_metadata_source_provider_idx" ON "item_metadata"("source_provider")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "retractions_doi_key" ON "retractions"("doi")',
      'CREATE INDEX IF NOT EXISTS "retractions_pmid_idx" ON "retractions"("pmid")',
      'CREATE INDEX IF NOT EXISTS "retractions_is_retracted_nature_idx" ON "retractions"("is_retracted", "nature")',
      'CREATE INDEX IF NOT EXISTS "retractions_checked_at_idx" ON "retractions"("checked_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "user_publications_user_id_is_public_idx" ON "user_publications"("user_id", "is_public")',
      'CREATE INDEX IF NOT EXISTS "user_publications_item_id_idx" ON "user_publications"("item_id")',
      'CREATE INDEX IF NOT EXISTS "item_field_mappings_base_field_idx" ON "item_field_mappings"("base_field")',
      'CREATE INDEX IF NOT EXISTS "annotations_attachment_id_deleted_at_annotation_sort_index_idx" ON "annotations"("attachment_id", "deleted_at", "annotation_sort_index")',
      'CREATE INDEX IF NOT EXISTS "annotations_attachment_id_deleted_at_page_index_idx" ON "annotations"("attachment_id", "deleted_at", "page_index")',
      'CREATE INDEX IF NOT EXISTS "annotations_author_id_deleted_at_idx" ON "annotations"("author_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "annotations_tags_idx" ON "annotations" USING GIN ("tags")',
      'CREATE INDEX IF NOT EXISTS "attachment_revisions_file_id_idx" ON "attachment_revisions"("file_id")',
      'CREATE INDEX IF NOT EXISTS "attachments_item_id_attachment_type_idx" ON "attachments"("item_id", "attachment_type")',
      'CREATE INDEX IF NOT EXISTS "attachments_item_id_deleted_at_idx" ON "attachments"("item_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "attachments_extraction_status_extraction_started_at_idx" ON "attachments"("extraction_status", "extraction_started_at")',
      'CREATE INDEX IF NOT EXISTS "collection_items_collection_id_sort_order_idx" ON "collection_items"("collection_id", "sort_order")',
      'CREATE INDEX IF NOT EXISTS "collections_parent_id_idx" ON "collections"("parent_id")',
      'CREATE INDEX IF NOT EXISTS "collections_user_id_parent_id_sort_order_deleted_at_idx" ON "collections"("user_id", "parent_id", "sort_order", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "collections_project_id_parent_id_deleted_at_idx" ON "collections"("project_id", "parent_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "contributors_orcid_idx" ON "contributors"("orcid")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_user_id_idempotency_key_key" ON "idempotency_records"("user_id", "idempotency_key")',
      'CREATE INDEX IF NOT EXISTS "ingestion_runs_user_id_started_at_idx" ON "ingestion_runs"("user_id", "started_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "ingestion_runs_project_id_started_at_idx" ON "ingestion_runs"("project_id", "started_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "ingestion_runs_item_id_idx" ON "ingestion_runs"("item_id")',
      'CREATE INDEX IF NOT EXISTS "ingestion_runs_status_next_retry_at_idx" ON "ingestion_runs"("status", "next_retry_at")',
      'CREATE INDEX IF NOT EXISTS "ingestion_runs_status_updated_at_idx" ON "ingestion_runs"("status", "updated_at")',
      'CREATE INDEX IF NOT EXISTS "ingestion_runs_user_id_input_hash_idx" ON "ingestion_runs"("user_id", "input_hash")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_runs_user_id_idempotency_key_key" ON "ingestion_runs"("user_id", "idempotency_key")',
      'CREATE INDEX IF NOT EXISTS "library_changes_entity_type_entity_id_idx" ON "library_changes"("entity_type", "entity_id")',
      'CREATE INDEX IF NOT EXISTS "notes_item_id_deleted_at_idx" ON "notes"("item_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "notes_user_id_deleted_at_updated_at_idx" ON "notes"("user_id", "deleted_at", "updated_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "notes_project_id_deleted_at_idx" ON "notes"("project_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "notes_tags_idx" ON "notes" USING GIN ("tags")',
      'CREATE INDEX IF NOT EXISTS "outbox_events_status_scheduled_at_lease_expires_at_idx" ON "outbox_events"("status", "scheduled_at", "lease_expires_at")',
      'CREATE INDEX IF NOT EXISTS "outbox_events_dedupe_key_idx" ON "outbox_events"("dedupe_key")',
      'CREATE INDEX IF NOT EXISTS "saved_searches_user_id_deleted_at_idx" ON "saved_searches"("user_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "saved_searches_project_id_deleted_at_idx" ON "saved_searches"("project_id", "deleted_at")',
      'CREATE INDEX IF NOT EXISTS "tags_project_id_name_idx" ON "tags"("project_id", "name")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "tags_user_id_name_project_id_key" ON "tags"("user_id", "name", "project_id")',
      'CREATE INDEX IF NOT EXISTS "tombstones_user_id_seq_idx" ON "tombstones"("user_id", "seq")',
      'CREATE INDEX IF NOT EXISTS "tombstones_project_id_seq_idx" ON "tombstones"("project_id", "seq")',
      'CREATE INDEX IF NOT EXISTS "user_item_states_user_id_is_starred_idx" ON "user_item_states"("user_id", "is_starred")',
      'CREATE INDEX IF NOT EXISTS "user_item_states_user_id_last_opened_at_idx" ON "user_item_states"("user_id", "last_opened_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "user_item_states_item_id_idx" ON "user_item_states"("item_id")',
    ];
    for (const q of indexes) {
      await c.query(q);
    }

    // 9. Add Foreign Keys pointing to items
    console.log('Step 9: Adding foreign keys to items...');
    const fks = [
      'ALTER TABLE "user_item_states" ADD CONSTRAINT "user_item_states_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "notes" ADD CONSTRAINT "notes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "contributors" ADD CONSTRAINT "contributors_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "item_relations" ADD CONSTRAINT "item_relations_target_item_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "item_metadata" ADD CONSTRAINT "item_metadata_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "user_publications" ADD CONSTRAINT "user_publications_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE',
      'ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      'ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    ];
    for (const q of fks) {
      await c.query(q);
    }

    await c.query('COMMIT');
    console.log('✅ All migration steps completed successfully and committed!');
  } catch (err) {
    await c.query('ROLLBACK');
    console.error('❌ Migration failed, rolled back:', err);
    throw err;
  } finally {
    await c.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
