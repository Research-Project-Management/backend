import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { topoSortOperations, computeRequestHash } from './utils/sync-batch.utils';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import { OutboxWorker, OutboxDispatchHandler } from '../outbox/outbox.worker';
import {
  SyncPort,
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
} from './ports/sync.port';
import { CollectionsService } from '../collections/collections.service';
import { ItemsService } from '../items/items.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { NotesService } from '../notes/notes.service';
import { AnnotationsService } from '../annotations/annotations.service';

@Injectable()
export class SyncService implements SyncPort {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly txService: TransactionService,
    private readonly outboxWorker: OutboxWorker,
    private readonly collectionsService: CollectionsService,
    private readonly catalogService: ItemsService,
    private readonly attachmentsService: AttachmentsService,
    private readonly notesService: NotesService,
    private readonly annotationsService: AnnotationsService,
  ) {}

  async pullDelta(
    workspaceId: string,
    sinceSeq?: bigint | number,
    limit: number = 100,
  ) {
    const parsedSeq = sinceSeq !== undefined ? BigInt(sinceSeq) : BigInt(0);
    const parsedLimit = Math.min(Math.max(limit, 1), 500);

    const changes = await this.txService.getChangesSince(
      workspaceId,
      parsedSeq,
      parsedLimit,
    );
    const tombstones = await this.txService.getTombstonesSince(
      workspaceId,
      parsedSeq,
      parsedLimit,
    );
    const latestSeq = await this.txService.getLatestSequence(workspaceId);

    const serializedChanges = changes.map((c) => ({
      ...c,
      seq: c.seq.toString(),
    }));

    const serializedTombstones = tombstones.map((t) => ({
      ...t,
      seq: t.seq?.toString() ?? null,
    }));

    return {
      changes: serializedChanges,
      tombstones: serializedTombstones,
      latestSeq: latestSeq.toString(),
      hasMore:
        changes.length === parsedLimit || tombstones.length === parsedLimit,
    };
  }

  async pushMutations(
    workspaceId: string,
    mutations: Array<{
      entityType: string;
      entityId: string;
      action: 'create' | 'update' | 'delete';
      version: number;
      data?: any;
    }>,
  ) {
    return this.txService.executeInTransaction(async (tx, helpers) => {
      const results = [];
      for (const mutation of mutations) {
        if (mutation.action === 'delete') {
          await this.executeDeleteEntity(tx, helpers, {
            workspaceId,
            entityType: mutation.entityType as any,
            entityId: mutation.entityId,
          });
          const tombstone = await helpers.recordTombstone(workspaceId, {
            entityType: mutation.entityType,
            entityId: mutation.entityId,
          });
          results.push({
            entityId: mutation.entityId,
            action: 'delete',
            seq: tombstone.seq?.toString(),
          });
        } else {
          switch (mutation.entityType) {
            case 'CatalogItem':
              await this.executeUpsertCatalogItem(tx, helpers, {
                workspaceId,
                userId: mutation.data?.userId || 'system',
                existingId: mutation.entityId,
                title: mutation.data?.title || 'Untitled',
                ...(mutation.data || {}),
              });
              break;
            case 'Collection':
              await this.executeUpsertCollection(tx, helpers, {
                workspaceId,
                userId: mutation.data?.userId || 'system',
                existingId: mutation.entityId,
                name: mutation.data?.name || 'Untitled',
                ...(mutation.data || {}),
              });
              break;
            case 'CatalogAttachment':
              await this.executeUpsertAttachment(tx, helpers, {
                workspaceId,
                existingId: mutation.entityId,
                catalogItemId: mutation.data?.catalogItemId,
                filename: mutation.data?.filename || 'attachment',
                url: mutation.data?.url || '',
                mimeType: mutation.data?.mimeType || 'application/pdf',
                ...(mutation.data || {}),
              });
              break;
            case 'Note':
              await this.executeUpsertNote(tx, helpers, {
                workspaceId,
                userId: mutation.data?.userId || 'system',
                existingId: mutation.entityId,
                catalogItemId: mutation.data?.catalogItemId,
                title: mutation.data?.title || 'Note',
                contentMd: mutation.data?.contentMd || '',
                ...(mutation.data || {}),
              });
              break;
            case 'Annotation':
              await this.executeUpsertAnnotation(tx, helpers, {
                workspaceId,
                userId: mutation.data?.userId || 'system',
                existingId: mutation.entityId,
                attachmentId: mutation.data?.attachmentId,
                pageIndex: mutation.data?.pageIndex ?? 1,
                ...(mutation.data || {}),
              });
              break;
            default:
              this.logger.debug(
                `Generic changelog recorded for entityType: ${mutation.entityType}`,
              );
          }

          const change = await helpers.appendChange(workspaceId, {
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            action: mutation.action,
            version: mutation.version,
            data: mutation.data,
          });
          results.push({
            entityId: mutation.entityId,
            action: mutation.action,
            seq: change.seq.toString(),
          });
        }
      }
      return results;
    });
  }

  async getLatestSequence(workspaceId: string): Promise<bigint> {
    return this.txService.getLatestSequence(workspaceId);
  }

  async getItemSnapshot(
    query: GetSyncItemSnapshotQuery,
  ): Promise<SyncItemSnapshot | null> {
    return this.catalogService.getItemSnapshot(
      query.workspaceId,
      query.itemId,
    );
  }

  async getItemSnapshots(
    query: GetSyncItemSnapshotsQuery,
  ): Promise<SyncItemSummary[]> {
    if (!query.itemIds || query.itemIds.length === 0) {
      return [];
    }

    return this.catalogService.getItemSnapshots(
      query.workspaceId,
      query.itemIds,
    );
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
    // 1. Deterministic, non-mutating request hash
    const requestHash = computeRequestHash(command);


    // 2. Pre-flight idempotency check (fast-path, outside tx)
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

    // 3. Topological sort of collection operations
    const sortedOperations = topoSortOperations(command.operations);


    // 4. Execute all canonical writes in one atomic Library transaction
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

      // 4b. Execute operations in topo-sorted order
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
          const res = await this.executeUpsertCollection(
            tx,
            helpers,
            op.command,
          );
          if (op.operationId) refMap.set(op.operationId, res.id);
          results.push({ operationId: op.operationId, op: op.op, result: res });
        } else if (op.op === 'upsertCatalogItem') {
          const res = await this.executeUpsertCatalogItem(
            tx,
            helpers,
            op.command,
          );
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
          const res = await this.executeUpsertAttachment(
            tx,
            helpers,
            op.command,
          );
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
          const res = await this.executeUpsertAnnotation(
            tx,
            helpers,
            op.command,
          );
          if (op.operationId) refMap.set(op.operationId, res.id);
          results.push({ operationId: op.operationId, op: op.op, result: res });
        } else if (op.op === 'deleteEntity') {
          await this.executeDeleteEntity(tx, helpers, op.command);
          results.push({
            operationId: op.operationId,
            op: op.op,
            deleted: true,
          });
        }
      }

      const batchResult: ExternalSyncBatchResult = { results };

      // 4c. Mark idempotency record as succeeded INSIDE the same tx
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
    } catch (err: unknown) {
      if (err instanceof Error && (err as any).code === 'P2002' && dedupeKey) {
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

  //
  // Internal Transactional Execution Helpers
  //

  private async executeUpsertCollection(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncCollectionCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.collectionsService.upsertFromSync(command, tx, helpers);
  }

  private async executeUpsertCatalogItem(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncCatalogItemCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.catalogService.upsertFromSync(command, tx, helpers);
  }

  private async executeUpsertAttachment(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncAttachmentCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.attachmentsService.upsertFromSync(command, tx, helpers);
  }

  private async executeUpsertNote(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncNoteCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.notesService.upsertFromSync(command, tx, helpers);
  }

  private async executeUpsertAnnotation(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: UpsertSyncAnnotationCommand,
  ): Promise<UpsertSyncEntityResult> {
    return this.annotationsService.upsertFromSync(command, tx, helpers);
  }

  private async executeDeleteEntity(
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
    command: DeleteSyncEntityCommand,
  ): Promise<void> {
    switch (command.entityType) {
      case 'CatalogItem':
        return this.catalogService.deleteFromSync(command, tx, helpers);
      case 'Collection':
        return this.collectionsService.deleteFromSync(command, tx, helpers);
      case 'CatalogAttachment':
        return this.attachmentsService.deleteFromSync(command, tx, helpers);
      case 'Note':
        return this.notesService.deleteFromSync(command, tx, helpers);
      case 'Annotation':
        return this.annotationsService.deleteFromSync(command, tx, helpers);
      default:
        this.logger.warn(
          `executeDeleteEntity: unknown entityType "${command.entityType}" for ${command.entityId} in workspace ${command.workspaceId}`,
        );
    }
  }
}

