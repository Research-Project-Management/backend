-- =============================================================================
-- Identity Bounded Context — Schema Normalization, Integrity & Partial Indexes
-- =============================================================================
-- Safe, idempotent PostgreSQL DDL script for Enterprise Identity Domain.
--
-- Features:
--   1. Partial Unique Index on `users.email` (WHERE deleted_at IS NULL):
--      Resolves soft-delete insertion anomaly where deleted users prevent re-registration.
--   2. Data Integrity CHECK Constraints:
--      - Validates basic RFC email syntax (must contain '@' not at boundaries).
--      - Validates password hash minimum storage length when local auth is present.
--      - Validates token expiration guarantees (expires_at > created_at).
--   3. Partial Index on Active Refresh Tokens:
--      Accelerates JWT refresh validation by filtering out revoked/dead tokens.
--   4. Active Verification Tokens Index:
--      Accelerates email/password reset token lookup for non-expired tokens.
-- =============================================================================

-- 1. Soft-Delete Safe Partial Unique Index for User Email
DO $$
BEGIN
  -- Drop unconditional unique constraint if present
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'users_email_key'
  ) THEN
    -- Check if it's already a partial index
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'users_email_key' AND indexdef LIKE '%WHERE%deleted_at IS NULL%'
    ) THEN
      DROP INDEX IF EXISTS "users_email_key";
      CREATE UNIQUE INDEX "users_email_key" ON "users" ("email") WHERE "deleted_at" IS NULL;
    END IF;
  ELSE
    CREATE UNIQUE INDEX "users_email_key" ON "users" ("email") WHERE "deleted_at" IS NULL;
  END IF;
END $$;

-- 2. User Data Integrity Constraints
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_email_format') THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "chk_users_email_format"
      CHECK ("email" ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_password_length') THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "chk_users_password_length"
      CHECK ("password_hash" IS NULL OR length("password_hash") >= 20);
  END IF;
END $$;

-- 3. Partial Index on Active Unexpired Refresh Tokens
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_active"
  ON "refresh_tokens" ("user_id", "expires_at")
  WHERE "is_revoked" = false;

-- 4. Active Verification Tokens Index
CREATE INDEX IF NOT EXISTS "idx_verification_tokens_active"
  ON "verification_tokens" ("user_id", "type", "expires_at");

-- 5. Expiration Sanity Constraints
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_refresh_tokens_expires') THEN
    ALTER TABLE "refresh_tokens"
      ADD CONSTRAINT "chk_refresh_tokens_expires"
      CHECK ("expires_at" > "created_at");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_verification_tokens_expires') THEN
    ALTER TABLE "verification_tokens"
      ADD CONSTRAINT "chk_verification_tokens_expires"
      CHECK ("expires_at" > "created_at");
  END IF;
END $$;
