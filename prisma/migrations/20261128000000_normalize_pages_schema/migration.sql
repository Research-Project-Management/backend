-- Normalize Pages aggregate schema to 3NF:
-- 1. Create PageStatus enum and cast pages.status
DO $$ BEGIN
  CREATE TYPE "PageStatus" AS ENUM ('draft', 'published', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "pages" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "pages"
  ALTER COLUMN "status" TYPE "PageStatus"
  USING (
    CASE
      WHEN "status" IN ('draft', 'published', 'archived') THEN "status"::"PageStatus"
      ELSE 'draft'::"PageStatus"
    END
  );
ALTER TABLE "pages" ALTER COLUMN "status" SET DEFAULT 'draft'::"PageStatus";

-- 2. Concise, meaningful column names & TeX Live 2025 default
ALTER TABLE "pages" RENAME COLUMN "tex_live_version" TO "texlive";
ALTER TABLE "pages" ALTER COLUMN "texlive" SET DEFAULT '2025';
ALTER TABLE "pages" RENAME COLUMN "spell_check_language" TO "spell_lang";
ALTER TABLE "pages" RENAME COLUMN "pdf_thumbnail" TO "thumbnail";

CREATE INDEX IF NOT EXISTS "idx_pages_created_by" ON "pages"("created_by_id");

-- 3. 3NF PageLabel join table (replaces denormalized labels JSON in page_docs.ranges)
CREATE TABLE IF NOT EXISTS "page_labels" (
  "page_id" UUID NOT NULL,
  "label_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_page_labels" PRIMARY KEY ("page_id", "label_id"),
  CONSTRAINT "fk_page_labels_page_id" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_page_labels_label_id" FOREIGN KEY ("label_id") REFERENCES "space_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_page_labels_label_id" ON "page_labels"("label_id");

-- 4. Backfill existing labelIds stored in page_docs.ranges into page_labels
INSERT INTO "page_labels" ("page_id", "label_id")
SELECT DISTINCT pd."page_id", (elem #>> '{}')::uuid
FROM "page_docs" pd,
     jsonb_array_elements(COALESCE(pd."ranges" -> 'labelIds', '[]'::jsonb)) AS elem
JOIN "space_labels" sl ON sl."id" = (elem #>> '{}')::uuid
WHERE pd."ranges" IS NOT NULL
  AND jsonb_typeof(pd."ranges" -> 'labelIds') = 'array'
ON CONFLICT ("page_id", "label_id") DO NOTHING;
