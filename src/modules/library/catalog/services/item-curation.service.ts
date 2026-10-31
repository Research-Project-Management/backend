import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { ItemCacheCoordinator } from './item-cache.coordinator';
import { ItemQueryService } from './item-query.service';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import {
  CreateItemData,
  BibliographicReference,
} from '@/modules/library/core/types/bibliographic.types';
import { Prisma } from '@prisma/client';
import {
  LIBRARY_EVENT_TYPES,
  LIBRARY_REDIS_KEYS,
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  buildItemCreatedOutboxPayload,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import {
  ImportSourceItem,
  buildImportItemPayload,
  prepareItemAiMetadataPatch,
} from '@/modules/library/catalog/domain/command-payload.builder';

export type { ImportSourceItem };
export { buildImportItemPayload };

interface CslItemData {
  id?: string;
  title?: string;
  author?: Array<{ literal?: string; given?: string; family?: string }>;
  issued?: { 'date-parts'?: Array<Array<number | string>> };
  'container-title'?: string;
  journal?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string | number;
  DOI?: string;
  URL?: string;
}

interface CitationJsInstance {
  data?: CslItemData[];
}

type CitationJsConstructor = new (raw: string) => CitationJsInstance;

let cachedCite: CitationJsConstructor | null | undefined = null;

function getCite(): CitationJsConstructor | undefined {
  if (cachedCite === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Cite } = require('@citation-js/core') as {
        Cite: CitationJsConstructor;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@citation-js/plugin-bibtex');
      cachedCite = Cite;
    } catch {
      cachedCite = undefined;
    }
  }
  return cachedCite ?? undefined;
}

/**
 * ItemCurationService — Dedicated Domain Service for Item Curation, Scholarly Enrichment,
 * Cross-Project Imports, Attachment Processing Status, and Metadata Source Provenance.
 */
@Injectable()
export class ItemCurationService {
  private readonly cacheCoordinator: ItemCacheCoordinator;

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
    @Optional()
    @Inject(RedisCacheService)
    private readonly cache?: RedisCacheService,
    @Optional() private readonly itemQueryService?: ItemQueryService,
    @Optional()
    @Inject(ItemCacheCoordinator)
    cacheCoordinator?: ItemCacheCoordinator,
  ) {
    this.cacheCoordinator =
      cacheCoordinator ?? new ItemCacheCoordinator(this.cache);
  }

  /**
   * Parses raw unformatted citation strings or multi-line bibliographies into structured references.
   */
  parseCitations(rawCitations: string): Promise<BibliographicReference[]> {
    if (
      !rawCitations ||
      typeof rawCitations !== 'string' ||
      !rawCitations.trim()
    ) {
      return Promise.resolve([]);
    }

    try {
      const Cite = getCite();
      if (!Cite) return Promise.resolve([]);

      const cite = new Cite(rawCitations);
      const data = cite.data || [];
      return Promise.resolve(
        data.map((csl: CslItemData, index: number) => ({
          id: csl.id || `cite-${index + 1}`,
          rawCitation: rawCitations,
          title: csl.title || 'Untitled',
          authors: (csl.author || [])
            .map(
              (author: {
                literal?: string;
                given?: string;
                family?: string;
              }) => {
                if (author.literal) return author.literal.trim();
                if (author.given && author.family)
                  return `${author.given} ${author.family}`.trim();
                return (author.family || author.given || '').trim();
              },
            )
            .filter(Boolean),
          year:
            csl.issued?.['date-parts']?.[0]?.[0] != null
              ? Number(csl.issued['date-parts'][0][0])
              : undefined,
          journal: csl['container-title'] || csl.journal || undefined,
          volume: csl.volume ? String(csl.volume) : undefined,
          issue: csl.issue ? String(csl.issue) : undefined,
          pages: csl.page ? String(csl.page) : undefined,
          doi: csl.DOI || undefined,
          url: csl.URL || undefined,
        })),
      );
    } catch {
      return Promise.resolve([]);
    }
  }

  /**
   * Imports existing library items into a specific user project library.
   * Performs batch duplicate detection and transactional item duplication.
   */
  async importItemsToProject(
    userId: string,
    projectId: string,
    itemIds: string[],
  ): Promise<{ success: boolean; importedCount: number }> {
    const uniqueItemIds = Array.from(new Set(itemIds)).slice(0, 100);
    if (uniqueItemIds.length === 0) {
      return { success: true, importedCount: 0 };
    }

    const project = await this.query.findProjectWithMembers(projectId);

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const isMember =
      project.createdById === userId ||
      project.members.some(
        (member: { userId: string }) => member.userId === userId,
      );

    if (!isMember) {
      throw new ForbiddenException(
        'You do not have permission to import items to this project',
      );
    }

    if (this.itemQueryService) {
      const perms = await this.itemQueryService.getPermissions(
        userId,
        projectId,
      );
      if (!perms.permissions.canImport) {
        throw new ForbiddenException(
          'You do not have permission to import items to this project',
        );
      }
    }

    const sourceItems = await this.query.findManyByIdsWithFullDetails(
      userId,
      uniqueItemIds,
    );
    let importedCount = 0;

    // Batch query to detect duplicates in one go, avoiding N+1 queries.
    let existingDois = new Set<string>();
    let existingCitationKeys = new Set<string>();
    let existingTitles = new Set<string>();

    if (sourceItems.length > 0) {
      const existingItems = await this.query.findDuplicatesInProject(
        projectId,
        sourceItems.map((item) => ({
          doi: item.doi,
          citationKey: item.citationKey,
          title: item.title,
        })),
      );
      existingDois = new Set(
        existingItems
          .map((entry) => entry.doi?.trim().toLowerCase())
          .filter((doi): doi is string => Boolean(doi)),
      );
      existingCitationKeys = new Set(
        existingItems
          .map((entry) => entry.citationKey?.trim().toLowerCase())
          .filter((key): key is string => Boolean(key)),
      );
      existingTitles = new Set(
        existingItems
          .map((entry) => entry.title?.trim().toLowerCase())
          .filter((title): title is string => Boolean(title)),
      );
    }

    const candidatesToImport: Array<{
      source: ImportSourceItem;
      createData: CreateItemData;
    }> = [];

    for (const source of sourceItems) {
      const isDuplicate =
        Boolean(
          source.doi && existingDois.has(source.doi.trim().toLowerCase()),
        ) ||
        Boolean(
          source.title && existingTitles.has(source.title.trim().toLowerCase()),
        );

      if (isDuplicate) {
        continue;
      }

      const createData = buildImportItemPayload(source, userId);
      candidatesToImport.push({ source, createData });

      if (source.doi?.trim()) {
        existingDois.add(source.doi.trim().toLowerCase());
      }
      if (createData.citationKey?.trim()) {
        existingCitationKeys.add(createData.citationKey.trim().toLowerCase());
      }
      if (source.title?.trim()) {
        existingTitles.add(source.title.trim().toLowerCase());
      }
    }

    let ranPostCommitHook = false;
    if (candidatesToImport.length > 0) {
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
        const changeEntries: Array<{
          entityType: 'Item';
          entityId: string;
          action: 'create';
          version: number;
          data: unknown;
        }> = [];
        const outboxEvents: Array<{
          aggregateId: string;
          eventType: string;
          payload: unknown;
        }> = [];

        for (const { createData } of candidatesToImport) {
          const item = await this.command.create(
            userId,
            createData,
            tx,
            projectId,
          );

          const domainItem = ItemsMapper.toDomain(item);
          changeEntries.push({
            entityType: 'Item',
            entityId: item.id,
            action: 'create',
            version: item.version,
            data: domainItem,
          });

          const payload = buildItemCreatedOutboxPayload({
            itemId: item.id,
            userId,
            projectId,
            title: item.title,
            source: 'external_sync',
            doi: item.doi,
          });

          outboxEvents.push({
            aggregateId: item.id,
            eventType: LIBRARY_EVENT_TYPES.ITEM_CREATED,
            payload,
          });

          importedCount++;
        }

        if (helpers.appendChangesBatch) {
          await helpers.appendChangesBatch(
            { userId, projectId },
            changeEntries,
          );
        } else {
          for (const entry of changeEntries) {
            await helpers.appendChange({ userId, projectId }, entry);
          }
        }

        if (helpers.publishOutboxBatch) {
          await helpers.publishOutboxBatch({ userId, projectId }, outboxEvents);
        } else {
          for (const ev of outboxEvents) {
            await helpers.publishOutbox(
              { userId, projectId },
              ev.aggregateId,
              ev.eventType,
              ev.payload,
            );
          }
        }
        if (importedCount > 0) {
          helpers?.onAfterCommit?.(() =>
            this.cacheCoordinator.invalidateScopeListCache(userId, projectId),
          );
        }
      });
    }

    if (importedCount > 0 && !ranPostCommitHook) {
      await this.cacheCoordinator.invalidateScopeListCache(userId, projectId);
    }

    return { success: true, importedCount };
  }

  /**
   * Retrieves raw provenance metadata records for an item across all providers (arXiv, MeXtract, CrossRef).
   */
  async getMetadataSources(userId: string, itemId: string, projectId?: string) {
    const item = await this.query.findById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found in library`);
    }
    const sources = await this.query.findMetadataSources(itemId);
    return {
      itemId,
      count: sources.length,
      sources: sources.map((source) => ({
        id: source.id,
        sourceProvider: source.sourceProvider,
        sourceUri: source.sourceUri,
        format: source.format,
        fetchedAt: source.fetchedAt,
        createdAt: source.createdAt,
        rawPayload: source.rawPayload,
      })),
    };
  }

  async findAttachmentByFileId(
    fileId: string,
  ): Promise<{ id: string; itemId: string; metadata?: unknown } | null> {
    if (!fileId) return null;
    return this.query.findAttachmentByFileId(fileId);
  }

  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void> {
    if (!attachmentId) return;
    const existing = await this.query.findAttachmentById(attachmentId);
    if (!existing) return;

    const currentMeta =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    await this.command.updateAttachmentProcessingStatus(
      attachmentId,
      status,
      currentMeta,
      metadataPatch,
    );

    if (existing.itemId && this.cacheCoordinator) {
      await this.cacheCoordinator.invalidateItemCache(
        existing.itemId,
        undefined,
        undefined,
        { skipScopeInvalidation: true },
      );
    } else if (existing.itemId && this.cache) {
      await this.cache.delPattern(
        LIBRARY_REDIS_KEYS.itemPattern(existing.itemId),
      );
    }
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void> {
    if (!itemId) return;
    const existing = await this.query.findItemForAiMetadata(itemId);
    if (!existing) return;

    const currentMeta =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    const validProjectId = normalizeProjectScopeId(existing.projectId);
    const effectiveItemType = String(existing.itemType || 'journalArticle');

    const { filteredPatch, topLevelColumnSync, mergedMetadata } =
      prepareItemAiMetadataPatch({
        existingTitle: existing.title,
        effectiveItemType,
        currentMeta,
        aiMetadataPatch,
      });

    const invalidateUpdatedItemCache = async () => {
      if (this.cacheCoordinator && existing.userId) {
        await this.cacheCoordinator.invalidateForWrite({
          userId: existing.userId,
          projectId: validProjectId,
          itemIds: [itemId],
        });
      } else if (this.cacheCoordinator) {
        await this.cacheCoordinator.invalidateItemCache(
          itemId,
          existing.userId,
          validProjectId,
        );
      } else if (this.cache) {
        await this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId));
      }
    };

    let ranPostCommitHook = false;
    if (this.libraryTx && existing.userId) {
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
        const updated = await this.command.applyItemAiMetadataUpdate({
          itemId,
          existing: existing,
          filteredPatch,
          topLevelColumnSync,
          mergedMetadata,
          tx,
        });
        const mergedUpdated = {
          ...existing,
          ...(updated ?? {}),
          metadata: updated?.metadata ?? mergedMetadata,
        };
        const domainUpdated = ItemsMapper.toDomain(mergedUpdated);
        const eventScope = {
          userId: existing.userId,
          projectId: validProjectId,
        };
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: itemId,
          action: 'update',
          version: updated?.version ?? 1,
          data: domainUpdated,
        });
        await helpers.publishOutbox(
          eventScope,
          itemId,
          LIBRARY_EVENT_TYPES.ITEM_UPDATED,
          domainUpdated,
        );
        helpers?.onAfterCommit?.(invalidateUpdatedItemCache);
      });
    } else {
      await this.command.applyItemAiMetadataUpdate({
        itemId,
        existing: existing,
        filteredPatch,
        topLevelColumnSync,
        mergedMetadata,
      });
    }

    if (!ranPostCommitHook) {
      await invalidateUpdatedItemCache();
    }
  }
}

export async function executeBulkSoftDeleteInTx(params: {
  command: CommandRepository;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, userId, itemIds, tx, helpers, validProjectId } = params;
  const res = await command.softDeleteMany(userId, itemIds, tx, validProjectId);
  if (res.succeededIds.length > 0) {
    const eventScope = { userId, projectId: validProjectId };
    const deletedAt = new Date();
    const deletedIso = deletedAt.toISOString();
    await helpers.recordTombstonesBatch(
      eventScope,
      res.succeededIds.map((entityId) => ({ entityType: 'Item', entityId })),
    );
    await helpers.appendChangesBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        entityType: 'Item',
        entityId: id,
        action: 'delete',
        version: 0,
        data: { id, deletedAt: deletedIso },
      })),
    );
    await helpers.publishOutboxBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        aggregateId: id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_DELETED,
        payload: { id, deletedAt, projectId: validProjectId },
      })),
    );
  }
  return res;
}

export async function executeBulkRestoreInTx(params: {
  command: CommandRepository;
  query: QueryRepository;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, query, userId, itemIds, tx, helpers, validProjectId } =
    params;
  const res = await command.restoreMany(userId, itemIds, tx, validProjectId);
  if (res.restoredItems.length > 0) {
    const restoredFullItems = await query.findByIds(
      userId,
      res.succeededIds,
      validProjectId,
      tx,
      false,
    );
    const fullItemMap = new Map(
      (restoredFullItems || []).map((it) => [it.id, it]),
    );
    const restoredAt = new Date().toISOString();
    await helpers.appendChangesBatch(
      res.restoredItems.map((restored) => {
        const effectiveProjectId =
          validProjectId || restored.projectId || undefined;
        const fullItem = fullItemMap.get(restored.id);
        return {
          userId,
          projectId: effectiveProjectId,
          entityType: 'Item',
          entityId: restored.id,
          action: 'update' as const,
          version: restored.version,
          data: fullItem
            ? ItemsMapper.toDomain(fullItem)
            : {
                id: restored.id,
                version: restored.version,
                projectId: effectiveProjectId,
              },
        };
      }),
    );
    await helpers.removeTombstonesBatch(
      { userId, projectId: validProjectId },
      'Item',
      res.restoredItems.map((r) => r.id),
    );
    await helpers.publishOutboxBatch(
      res.restoredItems.map((restored) => {
        const effectiveProjectId =
          validProjectId || restored.projectId || undefined;
        return {
          userId,
          projectId: effectiveProjectId,
          aggregateId: restored.id,
          eventType: LIBRARY_EVENT_TYPES.ITEM_RESTORED,
          payload: {
            itemId: restored.id,
            userId,
            projectId: effectiveProjectId,
            restoredAt,
          },
        };
      }),
    );
  }
  return res;
}

export async function executeBulkPurgeInTx(params: {
  command: CommandRepository;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, userId, itemIds, tx, helpers, validProjectId } = params;
  const res = await command.purgeMany(userId, itemIds, tx, validProjectId);
  if (res.succeededIds.length > 0) {
    const eventScope = { userId, projectId: validProjectId };
    const purgedAt = new Date().toISOString();
    await helpers.recordTombstonesBatch(
      eventScope,
      res.succeededIds.map((entityId) => ({ entityType: 'Item', entityId })),
    );
    await helpers.appendChangesBatch(
      eventScope,
      res.succeededIds.map((entityId) => ({
        entityType: 'Item',
        entityId,
        action: 'delete',
        version: 0,
      })),
    );
    await helpers.publishOutboxBatch(
      eventScope,
      res.succeededIds.map((id, idx) => ({
        aggregateId: id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_PURGED,
        payload: {
          itemId: id,
          itemIds: res.succeededIds,
          userId,
          projectId: validProjectId,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
        },
      })),
    );
  }
  return res;
}

export async function executePurgeExpiredTrashInTx(params: {
  command: CommandRepository;
  retentionDays: number;
  limit: number;
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
}) {
  const { command, retentionDays, limit, tx, helpers } = params;
  const res = await command.purgeExpiredTrash(retentionDays, limit, tx);
  const expiredItems = res.expiredItems ?? [];
  const toTombstone = (
    rows: Array<{ id: string; userId: string; projectId?: string | null }> = [],
    entityType: string,
  ) =>
    rows.map((r) => ({
      userId: r.userId,
      projectId: r.projectId ?? undefined,
      entityType,
      entityId: r.id,
    }));

  const tombstoneInputs = [
    ...toTombstone(expiredItems, 'Item'),
    ...toTombstone(res.expiredNotes, 'Note'),
    ...toTombstone(res.expiredCollections, 'Collection'),
  ];

  if (tombstoneInputs.length > 0) {
    await helpers.recordTombstonesBatch(tombstoneInputs);
    await helpers.appendChangesBatch(
      tombstoneInputs.map((entry) => ({
        ...entry,
        action: 'delete' as const,
        version: 0,
      })),
    );
  }

  if (expiredItems.length > 0) {
    const purgedAt = new Date().toISOString();
    const allExpiredItemIds = expiredItems.map((it) => it.id);
    await helpers.publishOutboxBatch(
      expiredItems.map((it, idx) => ({
        userId: it.userId,
        projectId: it.projectId ?? undefined,
        aggregateId: it.id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_PURGED,
        payload: {
          itemId: it.id,
          itemIds: allExpiredItemIds,
          userId: it.userId,
          projectId: it.projectId ?? undefined,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
        },
      })),
    );
  }
  return res;
}
