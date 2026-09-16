import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/flux-db?schema=public',
});

async function main() {
  console.log('🔄 Applying PageSuggestion table migration...');

  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE "SuggestionStatus" AS ENUM ('pending', 'accepted', 'rejected');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    CREATE TABLE IF NOT EXISTS "page_suggestions" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "page_id" UUID NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
      "project_page_id" UUID,
      "author_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "type" TEXT NOT NULL DEFAULT 'replace',
      "original_text" TEXT NOT NULL DEFAULT '',
      "suggested_text" TEXT NOT NULL DEFAULT '',
      "from_line" INTEGER NOT NULL,
      "from_column" INTEGER NOT NULL DEFAULT 1,
      "to_line" INTEGER NOT NULL,
      "to_column" INTEGER NOT NULL DEFAULT 1,
      "description" TEXT DEFAULT '',
      "status" "SuggestionStatus" NOT NULL DEFAULT 'pending',
      "resolved_by_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
      "resolved_at" TIMESTAMPTZ(6),
      "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deleted_at" TIMESTAMPTZ(6)
    );

    CREATE INDEX IF NOT EXISTS "page_suggestions_page_id_status_idx" ON "page_suggestions"("page_id", "status");
    CREATE INDEX IF NOT EXISTS "page_suggestions_author_id_idx" ON "page_suggestions"("author_id");
  `);

  console.log('✅ PageSuggestion table created successfully!');
  await pool.end();
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
