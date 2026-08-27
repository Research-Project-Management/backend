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
CREATE UNIQUE INDEX "capture_previews_token_hash_key" ON "capture_previews"("token_hash");

-- CreateIndex
CREATE INDEX "capture_previews_workspace_id_expires_at_idx" ON "capture_previews"("workspace_id", "expires_at");

-- CreateIndex
CREATE INDEX "capture_previews_token_hash_idx" ON "capture_previews"("token_hash");

-- AddForeignKey
ALTER TABLE "capture_previews" ADD CONSTRAINT "capture_previews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_previews" ADD CONSTRAINT "capture_previews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
