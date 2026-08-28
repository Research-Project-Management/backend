import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  LibraryTransactionService,
  TransactionHelpers,
} from './library-transaction.service';
import { OutboxWorker, OutboxDispatchHandler } from './outbox.worker';
import {
  ILibrarySyncPort,
  SyncItemSnapshot,
  SyncItemSummary,
  GetSyncItemSnapshotQuery,
  GetSyncItemSnapshotsQuery,
  UpsertSyncCollectionCommand,
  UpsertSyncCatalogItemCommand,
  UpsertSyncAttachmentCommand,
  UpsertSyncNoteCommand,
  UpsertSyncAnnotationCommand,
  DeleteSyncEntityCommand,
  ApplyExternalSyncBatchCommand,
  ExternalSyncBatchResult,
  ExternalSyncBatchOperationResult,
  PublishIntegrationEventCommand,
  UpsertSyncEntityResult,
  IntegrationEventHandler,
} from '../library-sync.port';

@Injectable()
export class LibrarySyncBridgeService implements ILibrarySyncPort {
  private readonly logger = new Logger(LibrarySyncBridgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly txService: LibraryTransactionService,
    private readonly outboxWorker: OutboxWorker,
  ) {}

  async getItemSnapshot(
    query: GetSyncItemSnapshotQuery,
  ): Promise<SyncItemSnapshot | null> {
    const item = await this.prisma.catalogItem.findUnique({
      where: { id: query.itemId },
      include: {
        itemTags: { include: { tag: true } },
      },
    });

    if (!item || item.workspaceId !== query.workspaceId || item.deletedAt) {
      return null;
    }

    const tags = item.itemTags.map((it) => it.tag.name);

    return {
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      abstract: item.abstract,
      year: item.year,
      doi: item.doi,
      citationKey: item.citationKey,
      publicationTitle: item.publicationTitle,
      volume: item.volume,
      issue: item.issue,
      pages: item.pages,
      issn: item.issn,
      isbn: item.isbn,
      url: item.url,
      tags,
    };
  }

  async getItemSnapshots(
    query: GetSyncItemSnapshotsQuery,
  ): Promise<SyncItemSummary[]> {
    if (!query.itemIds || query.itemIds.length === 0) {
      return [];
    }

    const items = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId: query.workspaceId,
        id: { in: query.itemIds },
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        itemType: true,
        version: true,
        updatedAt: true,
      },
    });

    return items;
  }

  async upsertCollection(
    command: UpsertSyncCollectionCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.txService.executeInTransaction(async (tx, helpers) => {
      return this.executeUpsertCollection(tx, helpers, command);
    });
  }

  async upsertCatalogItem(
    command: UpsertSyncCatalogItemCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.txService.executeInTransaction(async (tx, helpers) => {
      return this.executeUpsertCatalogItem(tx, helpers, command);
    });
  }

  async upsertAttachment(
    command: UpsertSyncAttachmentCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.txService.executeInTransaction(async (tx, helpers) => {
      return this.executeUpsertAttachment(tx, helpers, command);
    });
  }

  async upsertNote(
    command: UpsertSyncNoteCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.txService.executeInTransaction(async (tx, helpers) => {
      return this.executeUpsertNote(tx, helpers, command);
    });
  }

  async upsertAnnotation(
    command: UpsertSyncAnnotationCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.txService.executeInTransaction(async (tx, helpers) => {
      return this.executeUpsertAnnotation(tx, helpers, command);
    });
  }

  async deleteEntity(command: DeleteSyncEntityCommand): Promise<void> {
    return this.txService.executeInTransaction(async (tx, helpers) => {
      return this.executeDeleteEntity(tx, helpers, command);
    });
  }

  /**
   * Applies an entire batch of external sync operations in a single atomic Library transaction.
   *
   * Reliability invariants:
   * 1. Deterministic idempotency: requestHash is computed from a stable canonical serialization
   *    of the operations WITHOUT mutating `command.operations`. No `as any` casts.
   * 2. Concurrent safety: idempotencyRecord is claimed inside the transaction via `create`.
   *    The DB unique constraint on (workspaceId, idempotencyKey) makes the second concurrent
   *    request fail with P2002, rolling back its canonical writes entirely. The losing request
   *    re-queries and returns the cached result.
   * 3. Parent reference safety: if `op.parentRef` is present but cannot be resolved from
   *    `refMap`, a NotFoundException is thrown inside the transaction — rolling back the batch.
   * 4. Collection topological safety: upsertCollection ops are sorted so parents are created
   *    before children. Circular hierarchies are rejected before execution.
   */
  async applyExternalSyncBatch(
    command: ApplyExternalSyncBatchCommand,
  ): Promise<ExternalSyncBatchResult> {
    // ── 1. Deterministic, non-mutating request hash ────────────────────────
    const requestHash = this.computeRequestHash(command);

    // ── 2. Pre-flight idempotency check (fast-path, outside tx) ───────────
    if (command.idempotencyKey) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: command.workspaceId,
            idempotencyKey: command.idempotencyKey,
          },
        },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            `Idempotency key ${command.idempotencyKey} was used with a different request payload`,
          );
        }
        if (existing.status === 'succeeded' && existing.responseBody) {
          this.logger.debug(
            `Idempotency cache hit for key ${command.idempotencyKey}. Returning cached result.`,
          );
          return existing.responseBody as unknown as ExternalSyncBatchResult;
        }
        // status === 'in_progress': a prior tx is still running or was rolled back.
        // Fall through to attempt re-claim inside tx below.
      }
    }

    // ── 3. Topological sort of collection operations ───────────────────────
    const sortedOperations = this.topoSortOperations(command.operations);

    // ── 4. Execute all canonical writes in one atomic Library transaction ──
    return this.txService.executeInTransaction(async (tx, helpers) => {
      // ── 4a. Claim idempotency record inside tx (prevents concurrent duplicate writes)
      if (command.idempotencyKey) {
        try {
          await tx.idempotencyRecord.create({
            data: {
              workspaceId: command.workspaceId,
              idempotencyKey: command.idempotencyKey,
              requestHash,
              status: 'in_progress',
              expiresAt: new Date(Date.now() + 86400 * 1000),
            },
          });
        } catch (err: unknown) {
          // P2002 = unique constraint violation: another concurrent request already claimed this key.
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            // Re-query under the now-committed record to get the cached result.
            const claimed = await this.prisma.idempotencyRecord.findUnique({
              where: {
                workspaceId_idempotencyKey: {
                  workspaceId: command.workspaceId,
                  idempotencyKey: command.idempotencyKey,
                },
              },
            });
            if (claimed?.requestHash !== requestHash) {
              throw new ConflictException(
                `Idempotency key ${command.idempotencyKey} was used with a different request payload`,
              );
            }
            if (claimed?.status === 'succeeded' && claimed.responseBody) {
              return claimed.responseBody as unknown as ExternalSyncBatchResult;
            }
            // Still in_progress (very unlikely): re-throw so the caller can retry later.
            throw new ConflictException(
              `Idempotency key ${command.idempotencyKey} is currently being processed by another request`,
            );
          }
          // Unexpected error — re-throw to rollback.
          throw err;
        }
      }

      // ── 4b. Execute operations in topo-sorted order ─────────────────────
      const refMap = new Map<string, string>();
      const results: ExternalSyncBatchOperationResult[] = [];

      for (const op of sortedOperations) {
        // Workspace membership guard
        if (op.command.workspaceId !== command.workspaceId) {
          throw new ForbiddenException(
            `Operation workspace mismatch: ${op.command.workspaceId} !== ${command.workspaceId}`,
          );
        }

        if (op.op === 'upsertCollection') {
          // Resolve parentRef if not already provided via existingId path
          if (op.parentRef && !op.command.parentCollectionId) {
            const resolved = refMap.get(op.parentRef);
            if (!resolved) {
              throw new NotFoundException(
                `Cannot resolve parentRef "${op.parentRef}" for upsertCollection (operationId: ${op.operationId ?? 'n/a'}). ` +
                  `Parent collection must appear earlier in the batch or have an existingId.`,
              );
            }
            op.command.parentCollectionId = resolved;
          }
          const res = await this.executeUpsertCollection(tx, helpers, op.command);
          if (op.operationId) refMap.set(op.operationId, res.id);
          results.push({ operationId: op.operationId, op: op.op, result: res });
        } else if (op.op === 'upsertCatalogItem') {
          const res = await this.executeUpsertCatalogItem(tx, helpers, op.command);
          if (op.operationId) refMap.set(op.operationId, res.id);
          results.push({ operationId: op.operationId, op: op.op, result: res });
        } else if (op.op === 'upsertAttachment') {
          if (op.parentRef && !op.command.catalogItemId) {
            const resolved = refMap.get(op.parentRef);
            if (!resolved) {
              throw new NotFoundException(
                `Cannot resolve parentRef "${op.parentRef}" for upsertAttachment (operationId: ${op.operationId ?? 'n/a'}). ` +
                  `Parent catalog item must appear earlier in the batch.`,
              );
            }
            op.command.catalogItemId = resolved;
          }
          const res = await this.executeUpsertAttachment(tx, helpers, op.command);
          if (op.operationId) refMap.set(op.operationId, res.id);
          results.push({ operationId: op.operationId, op: op.op, result: res });
        } else if (op.op === 'upsertNote') {
          if (op.parentRef && !op.command.catalogItemId) {
            const resolved = refMap.get(op.parentRef);
            if (!resolved) {
              throw new NotFoundException(
                `Cannot resolve parentRef "${op.parentRef}" for upsertNote (operationId: ${op.operationId ?? 'n/a'}). ` +
                  `Parent catalog item must appear earlier in the batch or have a catalogItemId.`,
              );
            }
            op.command.catalogItemId = resolved;
          }
          const res = await this.executeUpsertNote(tx, helpers, op.command);
          if (op.operationId) refMap.set(op.operationId, res.id);
          results.push({ operationId: op.operationId, op: op.op, result: res });
        } else if (op.op === 'upsertAnnotation') {
          if (op.parentRef && !op.command.attachmentId) {
            const resolved = refMap.get(op.parentRef);
            if (!resolved) {
              throw new NotFoundException(
                `Cannot resolve parentRef "${op.parentRef}" for upsertAnnotation (operationId: ${op.operationId ?? 'n/a'}). ` +
                  `Parent attachment must appear earlier in the batch or have an attachmentId.`,
              );
            }
            op.command.attachmentId = resolved;
          }
          const res = await this.executeUpsertAnnotation(tx, helpers, op.command);
          if (op.operationId) refMap.set(op.operationId, res.id);
          results.push({ operationId: op.operationId, op: op.op, result: res });
        } else if (op.op === 'deleteEntity') {
          await this.executeDeleteEntity(tx, helpers, op.command);
          results.push({ operationId: op.operationId, op: op.op, deleted: true });
        }
      }

      const batchResult: ExternalSyncBatchResult = { results };

      // ── 4c. Mark idempotency record as succeeded INSIDE the same tx ──────
      // If canonical writes rollback, this update also rollbacks — record stays 'in_progress'
      // and the next retry can re-acquire.
      if (command.idempotencyKey) {
        await tx.idempotencyRecord.update({
          where: {
            workspaceId_idempotencyKey: {
              workspaceId: command.workspaceId,
              idempotencyKey: command.idempotencyKey,
            },
          },
          data: {
            status: 'succeeded',
            statusCode: 200,
            responseBody: batchResult as unknown as Prisma.InputJsonValue,
            expiresAt: new Date(Date.now() + 86400 * 1000),
          },
        });
      }

      return batchResult;
    });
  }

  /**
   * Computes a deterministic SHA-256 hash from the batch operations without
   * mutating `command.operations`. Uses stable field ordering to ensure that
   * the same logical batch always produces the same hash across retries.
   *
   * Runtime-resolved IDs (existingId, catalogItemId, attachmentId,
   * parentCollectionId) are excluded so that a retry with already-resolved
   * bindings produces the same hash as the original request.
   */
  private computeRequestHash(command: ApplyExternalSyncBatchCommand): string {
    const canonical = command.operations.map((op) => {
      const { operationId, parentRef, op: opType, command: cmd } = op;
      // Cast through unknown to safely work with the discriminated union as a plain record.
      const raw = (cmd as unknown) as Record<string, unknown>;

      // Extract stable identity fields; discard runtime-resolved reference IDs.
      const {
        workspaceId,
        userId,
        existingId: _existingId,
        catalogItemId: _catalogItemId,
        attachmentId: _attachmentId,
        parentCollectionId: _parentCollectionId,
        ...stableFields
      } = raw;

      // Stable field ordering: sort keys alphabetically so insertion order
      // does not affect the hash across different JS engine versions.
      const sortedStable = Object.fromEntries(
        Object.entries(stableFields).sort(([a], [b]) => a.localeCompare(b)),
      );

      return {
        op: opType,
        operationId: operationId ?? null,
        parentRef: parentRef ?? null,
        workspaceId,
        userId: userId ?? null,
        ...sortedStable,
      };
    });

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');
  }


  /**
   * Topologically sorts upsertCollection operations so that parent collections
   * are processed before their children within the same batch.
   * Non-collection operations retain their original relative order after collections.
   * Throws ConflictException if a circular dependency is detected.
   */
  private topoSortOperations(
    operations: ApplyExternalSyncBatchCommand['operations'],
  ): ApplyExternalSyncBatchCommand['operations'] {
    const colOps = operations.filter((op) => op.op === 'upsertCollection');
    const otherOps = operations.filter((op) => op.op !== 'upsertCollection');

    if (colOps.length === 0) return operations;

    // Build a map: operationId → op, and determine edges (parentRef → operationId)
    const byOpId = new Map(
      colOps.filter((op) => op.operationId).map((op) => [op.operationId!, op]),
    );

    // Kahn's algorithm for topological sort
    const inDegree = new Map<string, number>();
    const children = new Map<string, string[]>(); // parentOpId → [childOpIds]

    for (const op of colOps) {
      if (op.operationId && !inDegree.has(op.operationId)) {
        inDegree.set(op.operationId, 0);
      }
    }

    for (const op of colOps) {
      if (op.parentRef && op.operationId && byOpId.has(op.parentRef)) {
        // Parent is in this batch — add an edge
        const kids = children.get(op.parentRef) ?? [];
        kids.push(op.operationId);
        children.set(op.parentRef, kids);
        inDegree.set(op.operationId, (inDegree.get(op.operationId) ?? 0) + 1);
      }
      // If parentRef is set but NOT in this batch, it's a cross-batch reference —
      // the parent must already exist in the DB (resolved via existingId before tx).
      // We don't fail here; strict enforcement happens later inside the tx via refMap.
    }

    const queue: string[] = [];
    for (const [opId, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(opId);
    }
    // Include ops without operationId — they go first (no ordering constraint)
    const noIdOps = colOps.filter((op) => !op.operationId);

    const sorted: ApplyExternalSyncBatchCommand['operations'] = [...noIdOps];
    let processed = 0;

    while (queue.length > 0) {
      const opId = queue.shift()!;
      const op = byOpId.get(opId);
      if (op) {
        sorted.push(op);
        processed++;
      }
      for (const childId of children.get(opId) ?? []) {
        const newDeg = (inDegree.get(childId) ?? 1) - 1;
        inDegree.set(childId, newDeg);
        if (newDeg === 0) queue.push(childId);
      }
    }

    // If we couldn't process all ops with operationIds, there's a cycle
    if (processed !== byOpId.size) {
      throw new ConflictException(
        'Circular collection hierarchy detected in batch operations. ' +
          'Collections cannot be their own ancestors.',
      );
    }

    // Non-collection ops after all collections
    return [...sorted, ...otherOps];
  }



  async publishIntegrationEvent(
    command: PublishIntegrationEventCommand,
  ): Promise<{ id: string }> {
    const { workspaceId, aggregateId, eventType, dedupeKey, payload } = command;

    try {
      const event = await this.prisma.outboxEvent.create({
        data: {
          workspaceId,
          aggregateId,
          eventType,
          dedupeKey: dedupeKey || null,
          payload: payload as Prisma.InputJsonValue,
        },
      });
      return { id: event.id };
    } catch (err: any) {
      if (err.code === 'P2002' && dedupeKey) {
        this.logger.debug(
          `Outbox event with dedupeKey ${dedupeKey} already exists. Skipping duplicate insert.`,
        );
        return { id: `deduped-${dedupeKey}` };
      }
      throw err;
    }
  }

  registerIntegrationEventHandler(
    eventType: string,
    handler: IntegrationEventHandler,
  ): void {
    const dispatchHandler: OutboxDispatchHandler = {
      handle: async (evt: any) => {
        await handler({
          id: evt.id,
          workspaceId: evt.workspaceId,
          aggregateId: evt.aggregateId,
          eventType: evt.eventType,
          payload: evt.payload,
          dedupeKey: evt.dedupeKey,
          createdAt: evt.createdAt,
        });
      },
    };
    this.outboxWorker.registerHandler(eventType, dispatchHandler);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal Transactional Execution Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private async executeUpsertCollection(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncCollectionCommand,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.collection.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Collection ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Collection ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const updated = await tx.collection.update({
        where: { id: command.existingId },
        data: {
          name: command.name,
          description: command.description,
          parentId: command.parentCollectionId || null,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Collection',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { name: command.name },
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await tx.collection.create({
        data: {
          workspaceId: command.workspaceId,
          name: command.name,
          description: command.description,
          parentId: command.parentCollectionId || null,
          createdById: command.userId,
          version: 1,
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Collection',
        entityId: created.id,
        action: 'create',
        version: created.version,
        data: { name: command.name },
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.collection.created',
        { collectionId: created.id },
      );

      return { id: created.id, isNew: true, version: created.version };
    }
  }

  private async executeUpsertCatalogItem(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncCatalogItemCommand,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.catalogItem.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Catalog item ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Catalog item ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const updated = await tx.catalogItem.update({
        where: { id: command.existingId },
        data: {
          title: command.title,
          abstract: command.abstract,
          year: command.year,
          doi: command.doi,
          citationKey: command.citationKey,
          publicationTitle: command.publicationTitle,
          volume: command.volume,
          issue: command.issue,
          pages: command.pages,
          issn: command.issn,
          isbn: command.isbn,
          url: command.url,
          itemType: command.itemType,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogItem',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { title: command.title },
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await tx.catalogItem.create({
        data: {
          workspaceId: command.workspaceId,
          uploadedById: command.userId,
          filename: command.filename || 'item.pdf',
          fileUrl: command.fileUrl || command.url || '',
          title: command.title,
          abstract: command.abstract,
          year: command.year,
          doi: command.doi,
          citationKey: command.citationKey,
          publicationTitle: command.publicationTitle,
          volume: command.volume,
          issue: command.issue,
          pages: command.pages,
          issn: command.issn,
          isbn: command.isbn,
          url: command.url,
          itemType: command.itemType,
          version: 1,
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogItem',
        entityId: created.id,
        action: 'create',
        version: 1,
        data: { title: command.title },
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.item.created',
        { itemId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  private async executeUpsertAttachment(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncAttachmentCommand,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.catalogAttachment.findUnique({
        where: { id: command.existingId },
        include: { catalogItem: true },
      });

      if (!existing) {
        throw new NotFoundException(
          `Attachment ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.catalogItem.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Attachment ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const revisionCount = await tx.attachmentRevision.count({
        where: { attachmentId: command.existingId },
      });
      const nextRevisionNumber = revisionCount + 1;

      const updated = await tx.catalogAttachment.update({
        where: { id: command.existingId },
        data: {
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          size: command.size !== undefined ? command.size : undefined,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: updated.id,
          revisionNumber: nextRevisionNumber,
          fileHash: command.fileHash || '',
          sizeBytes: command.size || 0,
          url: command.url,
          comment: 'Sync update',
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogAttachment',
        entityId: updated.id,
        action: 'update',
        version: nextRevisionNumber,
      });

      return { id: updated.id, isNew: false, version: nextRevisionNumber };
    } else {
      if (!command.catalogItemId) {
        throw new NotFoundException(
          `Parent catalog item ID required for attachment ${command.filename}`,
        );
      }

      const item = await tx.catalogItem.findUnique({
        where: { id: command.catalogItemId },
      });

      if (!item || item.workspaceId !== command.workspaceId) {
        throw new NotFoundException(
          `Catalog item ${command.catalogItemId} not found in workspace ${command.workspaceId}`,
        );
      }

      const created = await tx.catalogAttachment.create({
        data: {
          catalogItemId: command.catalogItemId,
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          attachmentType: (command.attachmentType as any) || 'primary_pdf',
          size: command.size || 0,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: created.id,
          revisionNumber: 1,
          fileHash: command.fileHash || '',
          sizeBytes: command.size || 0,
          url: command.url,
          comment: 'Initial sync',
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogAttachment',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.attachment.created',
        { attachmentId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  private async executeUpsertNote(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncNoteCommand,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.note.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Note ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Note ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const updated = await tx.note.update({
        where: { id: command.existingId },
        data: {
          contentMd: command.contentMd,
          title: command.title,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Note',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await tx.note.create({
        data: {
          workspaceId: command.workspaceId,
          createdById: command.userId,
          itemId: command.catalogItemId,
          contentMd: command.contentMd,
          title: command.title || 'Note',
          version: 1,
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Note',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.note.created',
        { noteId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  private async executeUpsertAnnotation(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncAnnotationCommand,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.annotation.findUnique({
        where: { id: command.existingId },
        include: { attachment: { include: { catalogItem: true } } },
      });

      if (!existing) {
        throw new NotFoundException(
          `Annotation ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.attachment.catalogItem.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Annotation ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const updated = await tx.annotation.update({
        where: { id: command.existingId },
        data: {
          quoteText: command.quoteText,
          comment: command.comment,
          color: command.color,
          pageIndex: command.pageIndex,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Annotation',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      if (!command.attachmentId) {
        throw new NotFoundException(
          `Parent attachment ID required for annotation on page ${command.pageIndex}`,
        );
      }

      const att = await tx.catalogAttachment.findUnique({
        where: { id: command.attachmentId },
        include: { catalogItem: true },
      });

      if (!att || att.catalogItem.workspaceId !== command.workspaceId) {
        throw new NotFoundException(
          `Attachment ${command.attachmentId} not found in workspace ${command.workspaceId}`,
        );
      }

      const created = await tx.annotation.create({
        data: {
          attachmentId: command.attachmentId,
          authorId: command.userId,
          pageIndex: command.pageIndex,
          quoteText: command.quoteText || '',
          comment: command.comment || '',
          color: command.color || '#ffd400',
          type: (command.type as any) || 'highlight',
          version: 1,
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Annotation',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.annotation.created',
        { annotationId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  private async executeDeleteEntity(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: DeleteSyncEntityCommand,
  ): Promise<void> {
    const {
      workspaceId,
      entityType,
      entityId,
      reason,
      publishOutboxEventType,
      publishOutboxPayload,
    } = command;

    if (entityType === 'CatalogItem') {
      const existing = await tx.catalogItem.findUnique({
        where: { id: entityId },
      });

      if (!existing) {
        return;
      }

      if (existing.workspaceId !== workspaceId) {
        throw new ForbiddenException(
          `Catalog item ${entityId} does not belong to workspace ${workspaceId}`,
        );
      }

      await tx.catalogItem.update({
        where: { id: entityId },
        data: { deletedAt: new Date() },
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId,
        action: 'delete',
        version: existing.version + 1,
        data: { reason },
      });

      await helpers.recordTombstone(workspaceId, {
        entityType: 'CatalogItem',
        entityId,
      });

      const eventType = publishOutboxEventType || 'library.item.deleted';
      const payload = publishOutboxPayload || { itemId: entityId, reason };

      await helpers.publishOutbox(workspaceId, entityId, eventType, payload as any);
    } else if (entityType === 'Collection') {
      const existing = await tx.collection.findUnique({
        where: { id: entityId },
      });

      if (!existing) {
        return;
      }

      if (existing.workspaceId !== workspaceId) {
        throw new ForbiddenException(
          `Collection ${entityId} does not belong to workspace ${workspaceId}`,
        );
      }

      await tx.collection.update({
        where: { id: entityId },
        data: { deletedAt: new Date() },
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'Collection',
        entityId,
        action: 'delete',
        version: existing.version + 1,
      });

      await helpers.recordTombstone(workspaceId, {
        entityType: 'Collection',
        entityId,
      });
    } else if (entityType === 'CatalogAttachment') {
      const existing = await tx.catalogAttachment.findUnique({
        where: { id: entityId },
        include: { catalogItem: true },
      });

      if (!existing) {
        return;
      }

      if (existing.catalogItem.workspaceId !== workspaceId) {
        throw new ForbiddenException(
          `Attachment ${entityId} does not belong to workspace ${workspaceId}`,
        );
      }

      await tx.catalogAttachment.delete({
        where: { id: entityId },
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogAttachment',
        entityId,
        action: 'delete',
        version: 1,
      });
    } else if (entityType === 'Note') {
      const existing = await tx.note.findUnique({
        where: { id: entityId },
      });

      if (!existing) {
        return;
      }

      if (existing.workspaceId !== workspaceId) {
        throw new ForbiddenException(
          `Note ${entityId} does not belong to workspace ${workspaceId}`,
        );
      }

      await tx.note.update({
        where: { id: entityId },
        data: { deletedAt: new Date() },
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'Note',
        entityId,
        action: 'delete',
        version: existing.version + 1,
      });
    } else if (entityType === 'Annotation') {
      const existing = await tx.annotation.findUnique({
        where: { id: entityId },
        include: { attachment: { include: { catalogItem: true } } },
      });

      if (!existing) {
        return;
      }

      if (existing.attachment.catalogItem.workspaceId !== workspaceId) {
        throw new ForbiddenException(
          `Annotation ${entityId} does not belong to workspace ${workspaceId}`,
        );
      }

      await tx.annotation.update({
        where: { id: entityId },
        data: { deletedAt: new Date() },
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'Annotation',
        entityId,
        action: 'delete',
        version: existing.version + 1,
      });
    }
  }
}
