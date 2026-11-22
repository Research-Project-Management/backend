-- AlterEnum
ALTER TYPE "UploadSessionStatus" ADD VALUE IF NOT EXISTS 'FINALIZING';

-- AlterTable
ALTER TABLE "file_uploads" ADD COLUMN IF NOT EXISTS "finalizing_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "result_blob_id" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_file_uploads_space_active" ON "file_uploads"("space_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_file_uploads_creator_active" ON "file_uploads"("created_by_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_file_uploads_finalizing_stale" ON "file_uploads"("status", "finalizing_at");
CREATE INDEX IF NOT EXISTS "idx_file_uploads_result_blob" ON "file_uploads"("result_blob_id");

-- AddForeignKey
ALTER TABLE "file_uploads" ADD CONSTRAINT "fk_file_uploads_result_blob_id" FOREIGN KEY ("result_blob_id") REFERENCES "file_blobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;