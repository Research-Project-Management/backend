-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "claimed_by" TEXT,
ADD COLUMN IF NOT EXISTS "dedupe_key" TEXT,
ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_events_status_scheduled_at_idx" ON "outbox_events"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_events_status_lease_expires_at_idx" ON "outbox_events"("status", "lease_expires_at");
