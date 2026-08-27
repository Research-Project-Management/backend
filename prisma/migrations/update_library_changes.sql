-- AlterTable
DELETE FROM "library_changes";
ALTER TABLE "library_changes" DROP CONSTRAINT "library_changes_pkey",
ADD COLUMN     "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
ALTER COLUMN "seq" DROP DEFAULT,
ADD CONSTRAINT "library_changes_pkey" PRIMARY KEY ("id");
DROP SEQUENCE IF EXISTS "library_changes_seq_seq";
