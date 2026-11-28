-- ============================================================================
-- Migration: Normalize Pages Templates Schema to BCNF / 4NF (Flux Space & FileBlob Aligned)
-- - Persisted `page_templates` belong strictly to `spaces` (`personal` | `project`)
-- - Zero binary BYTEA in PostgreSQL: binary entries point zero-copy to `file_blobs` (`blob_id` / `storage_key`)
-- - True BCNF: eliminated denormalized `author` (resolved via `created_by_id`) and vanity columns
-- ============================================================================

DROP TABLE IF EXISTS "page_template_tags" CASCADE;
DROP TABLE IF EXISTS "page_template_files" CASCADE;
DROP TABLE IF EXISTS "page_templates" CASCADE;
DROP TABLE IF EXISTS "template_blobs" CASCADE;
DROP TYPE IF EXISTS "TemplateVisibility" CASCADE;
DROP TYPE IF EXISTS "TemplateCategory" CASCADE;

CREATE TYPE "TemplateCategory" AS ENUM (
  'journal',
  'conference',
  'book',
  'letter',
  'assignment',
  'poster',
  'presentation',
  'report',
  'cv',
  'thesis',
  'other'
);

CREATE TABLE "template_blobs" (
  "content_hash" CHAR(64) NOT NULL,
  "text_content" TEXT,
  "blob_id" UUID,
  "storage_key" VARCHAR(512),
  "bucket_name" VARCHAR(128),
  "mime_type" VARCHAR(128) NOT NULL DEFAULT 'text/x-tex',
  "size_bytes" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "template_blobs_pkey" PRIMARY KEY ("content_hash"),
  CONSTRAINT "chk_template_blobs_payload" CHECK (
    ("text_content" IS NOT NULL AND "storage_key" IS NULL)
    OR ("text_content" IS NULL AND "storage_key" IS NOT NULL)
  ),
  CONSTRAINT "fk_template_blobs_file_blob" FOREIGN KEY ("blob_id")
    REFERENCES "file_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_template_blobs_blob_id" ON "template_blobs"("blob_id");

CREATE TABLE "page_templates" (
  "id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "source_page_id" UUID,
  "created_by_id" UUID NOT NULL,
  "slug" VARCHAR(128) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "category" "TemplateCategory" NOT NULL DEFAULT 'other',
  "description" TEXT,
  "compiler" VARCHAR(32) NOT NULL DEFAULT 'pdflatex',
  "texlive" VARCHAR(16) NOT NULL DEFAULT '2025',
  "main_file" VARCHAR(255) NOT NULL DEFAULT 'main.tex',
  "thumbnail" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "page_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_page_templates_space_slug" UNIQUE ("space_id", "slug"),
  CONSTRAINT "fk_page_templates_space" FOREIGN KEY ("space_id")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_page_templates_source_page" FOREIGN KEY ("source_page_id")
    REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "fk_page_templates_creator" FOREIGN KEY ("created_by_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_page_templates_space_cat_updated" ON "page_templates"("space_id", "category", "updated_at" DESC);
CREATE INDEX "idx_page_templates_source_page" ON "page_templates"("source_page_id", "space_id");
CREATE INDEX "idx_page_templates_creator" ON "page_templates"("created_by_id", "created_at" DESC);

CREATE TABLE "page_template_files" (
  "template_id" UUID NOT NULL,
  "pathname" VARCHAR(512) NOT NULL,
  "type" "PageNodeType" NOT NULL DEFAULT 'DOC',
  "content_hash" CHAR(64) NOT NULL,

  CONSTRAINT "page_template_files_pkey" PRIMARY KEY ("template_id", "pathname"),
  CONSTRAINT "chk_page_template_files_type" CHECK ("type" IN ('DOC', 'FILE')),
  CONSTRAINT "fk_page_template_files_template" FOREIGN KEY ("template_id")
    REFERENCES "page_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_page_template_files_blob" FOREIGN KEY ("content_hash")
    REFERENCES "template_blobs"("content_hash") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_page_template_files_hash" ON "page_template_files"("content_hash");

CREATE TABLE "page_template_tags" (
  "template_id" UUID NOT NULL,
  "tag" VARCHAR(64) NOT NULL,

  CONSTRAINT "page_template_tags_pkey" PRIMARY KEY ("template_id", "tag"),
  CONSTRAINT "fk_page_template_tags_template" FOREIGN KEY ("template_id")
    REFERENCES "page_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_page_template_tags_lookup" ON "page_template_tags"("tag", "template_id");
