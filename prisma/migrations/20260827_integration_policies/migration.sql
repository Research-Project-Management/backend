-- CreateTable
CREATE TABLE IF NOT EXISTS "integration_policies" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "changed_by" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "integration_policies_provider_key" ON "integration_policies"("provider");
