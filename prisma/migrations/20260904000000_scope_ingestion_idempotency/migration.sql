DROP INDEX IF EXISTS "IngestionRun_idempotency_key_key";

CREATE UNIQUE INDEX "IngestionRun_workspace_id_idempotency_key_key"
ON "ingestion_runs"("workspace_id", "idempotency_key");

CREATE INDEX "IngestionRun_idempotency_key_workspace_id_idx"
ON "ingestion_runs"("idempotency_key", "workspace_id");