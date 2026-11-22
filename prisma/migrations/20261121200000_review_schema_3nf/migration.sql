-- ============================================================================
-- Migration: Normalize Pages Review Sub-Domain to 3NF (6 tables + CHECK guards)
-- Zero data loss: backfills legacy page_* review rows before dropping old tables
-- ============================================================================

-- 1. Create normalized Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChangeType') THEN
    CREATE TYPE "ChangeType" AS ENUM ('insert', 'delete');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChangeStatus') THEN
    CREATE TYPE "ChangeStatus" AS ENUM ('pending', 'accepted', 'rejected');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReviewStatus') THEN
    CREATE TYPE "ReviewStatus" AS ENUM ('draft', 'in_review', 'changes_requested', 'approved', 'submitted', 'locked');
  END IF;
END $$;

-- 2. Create normalized Tables
CREATE TABLE IF NOT EXISTS "doc_reviews" (
  "doc_id" UUID NOT NULL,
  "status" "ReviewStatus" NOT NULL DEFAULT 'draft',
  "current_round" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "doc_reviews_pkey" PRIMARY KEY ("doc_id"),
  CONSTRAINT "chk_doc_reviews_round" CHECK ("current_round" >= 1)
);

CREATE TABLE IF NOT EXISTS "review_rounds" (
  "id" UUID NOT NULL,
  "doc_id" UUID NOT NULL,
  "round_number" INTEGER NOT NULL DEFAULT 1,
  "status" "ReviewStatus" NOT NULL DEFAULT 'in_review',
  "requested_by_id" UUID,
  "requested_at" TIMESTAMPTZ(6),
  "verdict_by_id" UUID,
  "verdict_at" TIMESTAMPTZ(6),
  "notes" TEXT,
  "deadline" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "review_rounds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_review_rounds_number" CHECK ("round_number" >= 1)
);

CREATE TABLE IF NOT EXISTS "doc_changes" (
  "id" UUID NOT NULL,
  "doc_id" UUID NOT NULL,
  "group_id" UUID,
  "type" "ChangeType" NOT NULL,
  "status" "ChangeStatus" NOT NULL DEFAULT 'pending',
  "text" TEXT NOT NULL,
  "start_line" INTEGER NOT NULL,
  "start_col" INTEGER NOT NULL,
  "end_line" INTEGER NOT NULL,
  "end_col" INTEGER NOT NULL,
  "anchor_start" BYTEA,
  "anchor_end" BYTEA,
  "base_doc_rev" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" UUID,
  "resolved_by_id" UUID,
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "doc_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_doc_changes_range" CHECK ("start_line" >= 0 AND "end_line" >= "start_line" AND "start_col" >= 0 AND "end_col" >= 0),
  CONSTRAINT "chk_doc_changes_resolved" CHECK (("status" = 'pending' AND "resolved_at" IS NULL) OR ("status" <> 'pending' AND "resolved_at" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "doc_comments" (
  "id" UUID NOT NULL,
  "doc_id" UUID NOT NULL,
  "quote" TEXT,
  "start_line" INTEGER NOT NULL,
  "start_col" INTEGER NOT NULL,
  "end_line" INTEGER NOT NULL,
  "end_col" INTEGER NOT NULL,
  "anchor_start" BYTEA,
  "anchor_end" BYTEA,
  "base_doc_rev" INTEGER,
  "is_resolved" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" UUID,
  "resolved_by_id" UUID,
  "resolved_at" TIMESTAMPTZ(6),
  "deleted_by_id" UUID,
  "deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "doc_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_doc_comments_range" CHECK ("start_line" >= 0 AND "end_line" >= "start_line" AND "start_col" >= 0 AND "end_col" >= 0),
  CONSTRAINT "chk_doc_comments_resolved" CHECK (("is_resolved" = false AND "resolved_at" IS NULL) OR ("is_resolved" = true AND "resolved_at" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "comment_replies" (
  "id" UUID NOT NULL,
  "comment_id" UUID NOT NULL,
  "content" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" UUID,
  "updated_by_id" UUID,
  "deleted_by_id" UUID,
  "deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "comment_replies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "comment_mentions" (
  "reply_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("reply_id", "user_id")
);

-- 3. Indexes & Foreign Keys
CREATE INDEX IF NOT EXISTS "idx_doc_reviews_status" ON "doc_reviews"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_review_rounds_doc_round" ON "review_rounds"("doc_id", "round_number");
CREATE INDEX IF NOT EXISTS "idx_review_rounds_doc_created" ON "review_rounds"("doc_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_doc_changes_doc_status" ON "doc_changes"("doc_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_doc_changes_group_id" ON "doc_changes"("group_id");
CREATE INDEX IF NOT EXISTS "idx_doc_changes_author" ON "doc_changes"("created_by_id");

CREATE INDEX IF NOT EXISTS "idx_doc_comments_doc_resolved" ON "doc_comments"("doc_id", "deleted_at", "is_resolved", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_doc_comments_author" ON "doc_comments"("created_by_id");

CREATE INDEX IF NOT EXISTS "idx_comment_replies_comment_created" ON "comment_replies"("comment_id", "deleted_at", "created_at");

CREATE INDEX IF NOT EXISTS "idx_comment_mentions_user_created" ON "comment_mentions"("user_id", "created_at" DESC);

ALTER TABLE "doc_reviews"
  ADD CONSTRAINT "fk_doc_reviews_doc_id" FOREIGN KEY ("doc_id") REFERENCES "page_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_rounds"
  ADD CONSTRAINT "fk_review_rounds_doc_id" FOREIGN KEY ("doc_id") REFERENCES "doc_reviews"("doc_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "doc_changes"
  ADD CONSTRAINT "fk_doc_changes_doc_id" FOREIGN KEY ("doc_id") REFERENCES "page_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "fk_doc_comments_doc_id" FOREIGN KEY ("doc_id") REFERENCES "page_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comment_replies"
  ADD CONSTRAINT "fk_comment_replies_comment_id" FOREIGN KEY ("comment_id") REFERENCES "doc_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comment_mentions"
  ADD CONSTRAINT "fk_comment_mentions_reply_id" FOREIGN KEY ("reply_id") REFERENCES "comment_replies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Backfill existing legacy rows safely (zero data loss)
DO $$
BEGIN
  IF to_regclass('public.page_doc_reviews') IS NOT NULL THEN
    INSERT INTO "doc_reviews" ("doc_id", "status", "current_round", "version", "created_at", "updated_at")
    SELECT
      r."doc_id",
      r."status"::text::"ReviewStatus",
      GREATEST(COALESCE(r."round_number", 1), 1),
      GREATEST(COALESCE(r."version", 1), 1),
      r."created_at",
      r."updated_at"
    FROM "page_doc_reviews" r
    WHERE EXISTS (SELECT 1 FROM "page_docs" d WHERE d."id" = r."doc_id")
    ON CONFLICT ("doc_id") DO NOTHING;

    INSERT INTO "review_rounds" (
      "id", "doc_id", "round_number", "status", "requested_by_id", "requested_at",
      "verdict_by_id", "verdict_at", "notes", "deadline", "created_at", "updated_at"
    )
    SELECT
      gen_random_uuid(),
      r."doc_id",
      GREATEST(COALESCE(r."round_number", 1), 1),
      r."status"::text::"ReviewStatus",
      r."requested_by_id",
      r."requested_at",
      r."verdict_by_id",
      r."verdict_at",
      r."notes",
      r."deadline",
      r."created_at",
      r."updated_at"
    FROM "page_doc_reviews" r
    WHERE EXISTS (SELECT 1 FROM "doc_reviews" dr WHERE dr."doc_id" = r."doc_id")
    ON CONFLICT ("doc_id", "round_number") DO NOTHING;
  END IF;

  IF to_regclass('public.page_track_changes') IS NOT NULL THEN
    INSERT INTO "doc_changes" (
      "id", "doc_id", "type", "status", "text", "start_line", "start_col", "end_line", "end_col",
      "version", "created_by_id", "resolved_by_id", "resolved_at", "created_at", "updated_at"
    )
    SELECT
      c."id",
      c."doc_id",
      c."type"::text::"ChangeType",
      c."status"::text::"ChangeStatus",
      c."text",
      GREATEST(c."start_line", 0),
      GREATEST(c."start_col", 0),
      GREATEST(c."end_line", GREATEST(c."start_line", 0)),
      GREATEST(c."end_col", 0),
      1,
      c."created_by_id",
      c."resolved_by_id",
      CASE
        WHEN c."status"::text = 'pending' THEN NULL
        ELSE COALESCE(c."resolved_at", c."updated_at", c."created_at", CURRENT_TIMESTAMP)
      END,
      c."created_at",
      c."updated_at"
    FROM "page_track_changes" c
    WHERE EXISTS (SELECT 1 FROM "page_docs" d WHERE d."id" = c."doc_id")
    ON CONFLICT ("id") DO NOTHING;
  END IF;

  IF to_regclass('public.page_comment_threads') IS NOT NULL THEN
    INSERT INTO "doc_comments" (
      "id", "doc_id", "quote", "start_line", "start_col", "end_line", "end_col",
      "is_resolved", "version", "created_by_id", "resolved_by_id", "resolved_at", "created_at", "updated_at"
    )
    SELECT
      t."id",
      t."doc_id",
      t."quote",
      GREATEST(t."start_line", 0),
      GREATEST(t."start_col", 0),
      GREATEST(t."end_line", GREATEST(t."start_line", 0)),
      GREATEST(t."end_col", 0),
      t."is_resolved",
      1,
      t."created_by_id",
      t."resolved_by_id",
      CASE
        WHEN t."is_resolved" = false THEN NULL
        ELSE COALESCE(t."resolved_at", t."updated_at", t."created_at", CURRENT_TIMESTAMP)
      END,
      t."created_at",
      t."updated_at"
    FROM "page_comment_threads" t
    WHERE EXISTS (SELECT 1 FROM "page_docs" d WHERE d."id" = t."doc_id")
    ON CONFLICT ("id") DO NOTHING;
  END IF;

  IF to_regclass('public.page_comment_replies') IS NOT NULL THEN
    INSERT INTO "comment_replies" (
      "id", "comment_id", "content", "version", "created_by_id", "created_at", "updated_at"
    )
    SELECT
      r."id",
      r."thread_id",
      r."content",
      1,
      r."created_by_id",
      r."created_at",
      r."updated_at"
    FROM "page_comment_replies" r
    WHERE EXISTS (SELECT 1 FROM "doc_comments" dc WHERE dc."id" = r."thread_id")
    ON CONFLICT ("id") DO NOTHING;
  END IF;
END $$;

-- 5. Drop legacy tables & enums
DROP TABLE IF EXISTS "page_comment_replies";
DROP TABLE IF EXISTS "page_comment_threads";
DROP TABLE IF EXISTS "page_track_changes";
DROP TABLE IF EXISTS "page_doc_reviews";

DROP TYPE IF EXISTS "PageChangeType";
DROP TYPE IF EXISTS "PageChangeStatus";
DROP TYPE IF EXISTS "PageReviewStatus";
