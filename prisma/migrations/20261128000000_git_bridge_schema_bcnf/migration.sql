-- ============================================================================
-- Git Bridge Schema Normalization (1NF -> 2NF -> 3NF -> BCNF + Domain CHECKs)
-- Tables: git_access_tokens, page_git_repos, git_push_events
-- ============================================================================

-- 1. git_access_tokens (BCNF: CK1 = {id}, CK2 = {token_hash}; atomic CHAR(8) token_hint)
DROP TABLE IF EXISTS "public"."git_access_tokens" CASCADE;

CREATE TABLE "public"."git_access_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "token_hint" CHAR(8) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_access_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_git_access_tokens_expiry" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "chk_git_access_tokens_hash_hex" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "fk_git_access_tokens_user"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_git_access_tokens_hash" ON "public"."git_access_tokens"("token_hash");
CREATE INDEX "idx_git_access_tokens_user_created" ON "public"."git_access_tokens"("user_id", "created_at" DESC);
CREATE INDEX "idx_git_access_tokens_expires_at" ON "public"."git_access_tokens"("expires_at");

-- 2. page_git_repos (BCNF: 1:1 PK/FK = {page_id}; zero transitive space_id or derived aggregates)
CREATE TABLE IF NOT EXISTS "public"."page_git_repos" (
    "page_id" UUID NOT NULL,
    "head_commit_oid" CHAR(40),
    "root_tree_oid" CHAR(40),
    "is_materialized" BOOLEAN NOT NULL DEFAULT false,
    "gc_push_count" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_git_repos_pkey" PRIMARY KEY ("page_id"),
    CONSTRAINT "chk_page_git_repos_gc_nonneg" CHECK ("gc_push_count" >= 0),
    CONSTRAINT "chk_page_git_repos_head_hex" CHECK ("head_commit_oid" IS NULL OR "head_commit_oid" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "chk_page_git_repos_tree_hex" CHECK ("root_tree_oid" IS NULL OR "root_tree_oid" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "fk_page_git_repos_page"
        FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_page_git_repos_eviction" ON "public"."page_git_repos"("is_materialized", "last_accessed_at");

-- 3. git_push_events (BCNF: CK1 = {id}, CK2 = {page_id, after_oid}, CK3 = {snapshot_id})
CREATE TABLE IF NOT EXISTS "public"."git_push_events" (
    "id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "pusher_id" UUID,
    "snapshot_id" UUID,
    "before_oid" CHAR(40),
    "after_oid" CHAR(40) NOT NULL,
    "commit_subject" VARCHAR(255),
    "added_count" INTEGER NOT NULL DEFAULT 0,
    "modified_count" INTEGER NOT NULL DEFAULT 0,
    "deleted_count" INTEGER NOT NULL DEFAULT 0,
    "total_bytes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_push_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_git_push_events_counts_nonneg"
        CHECK ("added_count" >= 0 AND "modified_count" >= 0 AND "deleted_count" >= 0 AND "total_bytes" >= 0),
    CONSTRAINT "chk_git_push_events_after_hex" CHECK ("after_oid" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "chk_git_push_events_before_hex" CHECK ("before_oid" IS NULL OR "before_oid" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "fk_git_push_events_repo"
        FOREIGN KEY ("page_id") REFERENCES "public"."page_git_repos"("page_id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_git_push_events_pusher"
        FOREIGN KEY ("pusher_id") REFERENCES "public"."users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "fk_git_push_events_snapshot"
        FOREIGN KEY ("snapshot_id") REFERENCES "public"."page_snapshots"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_git_push_events_snapshot" ON "public"."git_push_events"("snapshot_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_git_push_events_page_after_oid" ON "public"."git_push_events"("page_id", "after_oid");
CREATE INDEX IF NOT EXISTS "idx_git_push_events_page_created" ON "public"."git_push_events"("page_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_git_push_events_pusher_created" ON "public"."git_push_events"("pusher_id", "created_at" DESC);

-- Clean legacy non-3NF JSONB gitTokens key from user_settings.editor_config if present
UPDATE "public"."user_settings"
SET "editor_config" = "editor_config" - 'gitTokens'
WHERE "editor_config" ? 'gitTokens';
