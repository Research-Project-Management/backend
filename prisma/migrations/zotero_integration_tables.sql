-- AlterTable
ALTER TABLE "library_changes" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "zotero_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'zotero',
    "account_name" TEXT,
    "account_type" TEXT DEFAULT 'user',
    "zotero_user_id" TEXT,
    "encrypted_api_key" TEXT NOT NULL,
    "key_iv" TEXT NOT NULL,
    "key_tag" TEXT NOT NULL,
    "scopes" JSONB DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_bindings" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "remote_library_type" TEXT NOT NULL DEFAULT 'user',
    "remote_library_id" TEXT NOT NULL,
    "last_sync_version" BIGINT NOT NULL DEFAULT 0,
    "last_sync_at" TIMESTAMP(3),
    "sync_status" TEXT NOT NULL DEFAULT 'idle',
    "sync_direction" TEXT NOT NULL DEFAULT 'read_only',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_item_bindings" (
    "id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "remote_key" TEXT NOT NULL,
    "remote_version" BIGINT NOT NULL DEFAULT 0,
    "base_snapshot" JSONB,
    "raw_payload" JSONB,
    "sync_state" TEXT NOT NULL DEFAULT 'synced',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_item_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_sync_runs" (
    "id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'pull',
    "version_before" BIGINT NOT NULL DEFAULT 0,
    "version_after" BIGINT NOT NULL DEFAULT 0,
    "items_created" INTEGER NOT NULL DEFAULT 0,
    "items_updated" INTEGER NOT NULL DEFAULT 0,
    "items_deleted" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "zotero_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zotero_sync_failures" (
    "id" TEXT NOT NULL,
    "sync_run_id" TEXT,
    "binding_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "remote_key" TEXT,
    "entity_id" TEXT,
    "error_message" TEXT NOT NULL,
    "error_details" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'retryable',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zotero_sync_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zotero_connections_workspace_id_status_idx" ON "zotero_connections"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_connections_workspace_id_zotero_user_id_key" ON "zotero_connections"("workspace_id", "zotero_user_id");

-- CreateIndex
CREATE INDEX "zotero_bindings_connection_id_idx" ON "zotero_bindings"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_bindings_workspace_id_remote_library_type_remote_lib_key" ON "zotero_bindings"("workspace_id", "remote_library_type", "remote_library_id");

-- CreateIndex
CREATE INDEX "zotero_item_bindings_workspace_id_entity_type_entity_id_idx" ON "zotero_item_bindings"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_item_bindings_binding_id_remote_key_key" ON "zotero_item_bindings"("binding_id", "remote_key");

-- CreateIndex
CREATE UNIQUE INDEX "zotero_item_bindings_binding_id_entity_type_entity_id_key" ON "zotero_item_bindings"("binding_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "zotero_sync_runs_binding_id_started_at_idx" ON "zotero_sync_runs"("binding_id", "started_at");

-- CreateIndex
CREATE INDEX "zotero_sync_failures_binding_id_status_idx" ON "zotero_sync_failures"("binding_id", "status");

-- AddForeignKey
ALTER TABLE "zotero_connections" ADD CONSTRAINT "zotero_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_connections" ADD CONSTRAINT "zotero_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_bindings" ADD CONSTRAINT "zotero_bindings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "zotero_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_bindings" ADD CONSTRAINT "zotero_bindings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_item_bindings" ADD CONSTRAINT "zotero_item_bindings_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "zotero_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_item_bindings" ADD CONSTRAINT "zotero_item_bindings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_runs" ADD CONSTRAINT "zotero_sync_runs_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "zotero_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_runs" ADD CONSTRAINT "zotero_sync_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_failures" ADD CONSTRAINT "zotero_sync_failures_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "zotero_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_failures" ADD CONSTRAINT "zotero_sync_failures_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "zotero_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zotero_sync_failures" ADD CONSTRAINT "zotero_sync_failures_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
