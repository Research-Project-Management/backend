-- ============================================================================
-- Templates & Gallery Schema Normalization (1NF -> BCNF / 4NF + CAS Blobs)
-- Tables: template_blobs, page_templates, page_template_files, page_template_tags
-- ============================================================================

DROP TABLE IF EXISTS "public"."page_template_tags" CASCADE;
DROP TABLE IF EXISTS "public"."page_template_files" CASCADE;
DROP TABLE IF EXISTS "public"."page_templates" CASCADE;
DROP TABLE IF EXISTS "public"."template_blobs" CASCADE;
DROP TYPE IF EXISTS "public"."PageTemplateCategory" CASCADE;
DROP TYPE IF EXISTS "public"."TemplateCategory" CASCADE;
DROP TYPE IF EXISTS "public"."TemplateVisibility" CASCADE;

CREATE TYPE "public"."TemplateCategory" AS ENUM (
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

CREATE TYPE "public"."TemplateVisibility" AS ENUM (
    'official',
    'workspace',
    'private'
);

CREATE TABLE "public"."template_blobs" (
    "content_hash" CHAR(64) NOT NULL,
    "text_content" TEXT,
    "binary_data" BYTEA,
    "mime_type" VARCHAR(128) NOT NULL DEFAULT 'text/plain',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_blobs_pkey" PRIMARY KEY ("content_hash"),
    CONSTRAINT "chk_template_blobs_hash_hex" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "chk_template_blobs_size_nonneg" CHECK ("size_bytes" >= 0),
    CONSTRAINT "chk_template_blobs_payload" CHECK ("text_content" IS NOT NULL OR "binary_data" IS NOT NULL)
);

CREATE TABLE "public"."page_templates" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(100),
    "version_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "category" "public"."TemplateCategory" NOT NULL DEFAULT 'other',
    "visibility" "public"."TemplateVisibility" NOT NULL DEFAULT 'private',
    "description" TEXT,
    "compiler" VARCHAR(32) NOT NULL DEFAULT 'pdflatex',
    "tex_live_version" VARCHAR(16) NOT NULL DEFAULT '2024',
    "main_file" VARCHAR(255) NOT NULL DEFAULT 'main.tex',
    "badge" VARCHAR(64) NOT NULL DEFAULT 'article',
    "author" VARCHAR(255) NOT NULL DEFAULT 'Flux Community',
    "license" VARCHAR(64) DEFAULT 'LPPL-1.3c',
    "source_url" VARCHAR(512),
    "thumbnail_url" TEXT,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "space_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_page_templates_downloads_nonneg" CHECK ("download_count" >= 0),
    CONSTRAINT "fk_page_templates_space"
        FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_page_templates_creator"
        FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_page_templates_slug" ON "public"."page_templates"("slug");
CREATE UNIQUE INDEX "uq_page_templates_version" ON "public"."page_templates"("version_id");
CREATE INDEX "idx_page_templates_vis_cat_dl" ON "public"."page_templates"("visibility", "category", "download_count" DESC);
CREATE INDEX "idx_page_templates_space_cat" ON "public"."page_templates"("space_id", "category", "created_at" DESC);
CREATE INDEX "idx_page_templates_creator" ON "public"."page_templates"("created_by_id", "created_at" DESC);

CREATE TABLE "public"."page_template_files" (
    "template_id" UUID NOT NULL,
    "pathname" VARCHAR(512) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'doc',
    "content_hash" CHAR(64) NOT NULL,

    CONSTRAINT "page_template_files_pkey" PRIMARY KEY ("template_id", "pathname"),
    CONSTRAINT "chk_page_template_files_kind" CHECK ("kind" IN ('doc', 'file')),
    CONSTRAINT "fk_page_template_files_template"
        FOREIGN KEY ("template_id") REFERENCES "public"."page_templates"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_page_template_files_blob"
        FOREIGN KEY ("content_hash") REFERENCES "public"."template_blobs"("content_hash")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_page_template_files_hash" ON "public"."page_template_files"("content_hash");

CREATE TABLE "public"."page_template_tags" (
    "template_id" UUID NOT NULL,
    "tag" VARCHAR(64) NOT NULL,

    CONSTRAINT "page_template_tags_pkey" PRIMARY KEY ("template_id", "tag"),
    CONSTRAINT "fk_page_template_tags_template"
        FOREIGN KEY ("template_id") REFERENCES "public"."page_templates"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_page_template_tags_lookup" ON "public"."page_template_tags"("tag", "template_id");
