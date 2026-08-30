import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  CatalogRepository,
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from './catalog.repository';
import { TransactionService } from '../sync/services/transaction.service';
import {
  SYNC_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
} from '../sync/events/library.events';
import { CursorPaginatedResult } from './dto/pagination.dto';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  MergeDuplicatesDto,
  DuplicateClusterResult,
  ALLOWED_MERGE_METADATA_FIELDS,
} from './dto/curation.dto';
import { normalizeTags } from '../tags/utils/tags.utils';

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly libraryTx: TransactionService,
    private readonly prisma: PrismaService,
  ) {}

  private mapFlattenedState(item: any, userId?: string) {
    if (!item) return null;
    const userState = Array.isArray(item.userStates)
      ? item.userStates[0]
      : undefined;
    const { userStates, ...rest } = item;
    return {
      ...rest,
      readStatus: userState?.readStatus ?? 'unread',
      rating: userState?.rating ?? 0,
      lastReadAt: userState?.lastReadAt
        ? userState.lastReadAt.toISOString()
        : null,
    };
  }

  async getItem(workspaceId: string, id: string, userId?: string) {
    const item = await this.catalogRepo.findById(workspaceId, id);
    if (!item) return null;
    return this.mapFlattenedState(item, userId);
  }

  async listItems(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<CursorPaginatedResult<any>> {
    const limit = Math.min(options.limit ?? 50, 100);
    const [totalCount, rawItems] = await Promise.all([
      this.catalogRepo.count(workspaceId, options),
      this.catalogRepo.findMany(workspaceId, {
        ...options,
        limit,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      const popped = rawItems.pop();
      nextCursor = popped?.id;
    }

    const items = rawItems.map((it) =>
      this.mapFlattenedState(it, options.userId),
    );

    return {
      items,
      meta: {
        cursor: nextCursor,
        hasNextPage,
        totalCount,
      },
    };
  }

  async createItem(
    workspaceId: string,
    data: CreateCatalogItemData,
    context?: {
      tx?: import('@prisma/client').Prisma.TransactionClient;
      helpers?: import('../sync/services/transaction.service').TransactionHelpers;
      source?: import('../sync/events/library.events').LibraryItemSource;
    },
  ): Promise<any> {
    if (context?.tx && context?.helpers) {
      const item = await this.catalogRepo.create(workspaceId, data, context.tx);

      await context.helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId,
        title: item.title,
        source: context.source || 'manual',
        doi: item.doi,
      });

      await context.helpers.publishOutbox(
        workspaceId,
        item.id,
        SYNC_EVENT_TYPES.ITEM_CREATED,
        payload,
      );

      return item;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const item = await this.catalogRepo.create(workspaceId, data, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId,
        title: item.title,
        source: context?.source || 'manual',
        doi: item.doi,
      });

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        SYNC_EVENT_TYPES.ITEM_CREATED,
        payload,
      );

      return item;
    });
  }

  async updateItem(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateCatalogItemData,
    context?: {
      tx: import('@prisma/client').Prisma.TransactionClient;
      helpers: import('../sync/services/transaction.service').TransactionHelpers;
    },
  ): Promise<any> {
    if (context) {
      const updated = await this.catalogRepo.update(
        workspaceId,
        id,
        expectedVersion,
        data,
        context.tx,
      );

      await context.helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await context.helpers.publishOutbox(
        workspaceId,
        id,
        SYNC_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      return updated;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.updateItem(workspaceId, id, expectedVersion, data, {
        tx,
        helpers,
      });
    });
  }

  async deleteItem(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    context?: {
      tx: import('@prisma/client').Prisma.TransactionClient;
      helpers: import('../sync/services/transaction.service').TransactionHelpers;
    },
  ): Promise<boolean> {
    if (context) {
      const deleted = await this.catalogRepo.softDelete(
        workspaceId,
        id,
        expectedVersion,
        context.tx,
      );

      if (deleted) {
        await context.helpers.recordTombstone(workspaceId, {
          entityType: 'CatalogItem',
          entityId: id,
        });

        await context.helpers.publishOutbox(
          workspaceId,
          id,
          'library.item.deleted',
          {
            id,
            deletedAt: new Date(),
          },
        );
      }

      return deleted;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.deleteItem(workspaceId, id, expectedVersion, { tx, helpers });
    });
  }

  async restoreItem(workspaceId: string, id: string, expectedVersion?: number) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const restored = await this.catalogRepo.restore(
        workspaceId,
        id,
        expectedVersion,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: restored.version,
        data: restored,
      });

      await helpers.publishOutbox(workspaceId, id, 'library.item.restored', {
        id,
        restoredAt: new Date(),
      });

      return restored;
    });
  }

  async purgeItem(workspaceId: string, id: string): Promise<boolean> {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const purged = await this.catalogRepo.purge(workspaceId, id, tx);

      await helpers.recordTombstone(workspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
      });

      await helpers.publishOutbox(workspaceId, id, 'library.item.purged', {
        id,
        purgedAt: new Date(),
      });

      return purged;
    });
  }

  async getRelatedItems(workspaceId: string, itemId: string) {
    const item = await this.catalogRepo.findById(workspaceId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.catalogRepo.getRelations(itemId);
    return {
      relatedItems: relations,
      relatedPapers: relations,
      total: relations.length,
    };
  }

  async linkItems(
    workspaceId: string,
    sourceItemId: string,
    data: { targetItemId: string; relationType?: string; note?: string },
  ) {
    const sourceItem = await this.catalogRepo.findById(
      workspaceId,
      sourceItemId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const targetItem = await this.catalogRepo.findById(
      workspaceId,
      data.targetItemId,
    );
    if (!targetItem) {
      throw new NotFoundException(`Target item ${data.targetItemId} not found`);
    }

    const linkedAt = new Date().toISOString();
    const type = data.relationType || 'related';

    const relation = {
      id: `rel_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      targetItemId: data.targetItemId,
      targetPaperId: data.targetItemId,
      targetId: data.targetItemId,
      relationType: type,
      type,
      note: data.note,
      description: data.note,
      linkedAt,
      createdAt: linkedAt,
    };

    await this.catalogRepo.putRelation(sourceItemId, relation);

    return {
      success: true,
      link: relation,
      message: `Linked "${sourceItem.title}" to "${targetItem.title}"`,
    };
  }

  async unlinkItems(
    workspaceId: string,
    sourceItemId: string,
    targetItemId: string,
  ) {
    const sourceItem = await this.catalogRepo.findById(
      workspaceId,
      sourceItemId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    await this.catalogRepo.removeRelation(sourceItemId, targetItemId);

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }

  /**
   * Scans active items in workspace and clusters duplicate candidates.
   * Tier 1: Exact normalized DOI.
   * Tier 2: Normalized title + publication year (+/- 1) + first author family name.
   */
  async detectDuplicates(
    workspaceId: string,
  ): Promise<DuplicateClusterResult[]> {
    const items = await this.prisma.catalogItem.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        title: true,
        doi: true,
        citationKey: true,
        year: true,
        authors: true,
        collectionId: true,
      },
    });

    const clusters: DuplicateClusterResult[] = [];
    const groupedItemIds = new Set<string>();

    // ── Tier 1: Exact normalized DOI ──────────────────────────────────────────
    const normalizeDoi = (raw?: string | null): string => {
      if (!raw) return '';
      return raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
        .replace(/^doi:\s*/i, '')
        .trim();
    };

    const doiMap = new Map<string, typeof items>();
    for (const item of items) {
      const cleanDoi = normalizeDoi(item.doi);
      if (cleanDoi) {
        const list = doiMap.get(cleanDoi) || [];
        list.push(item);
        doiMap.set(cleanDoi, list);
      }
    }

    doiMap.forEach((matched, doi) => {
      if (matched.length > 1) {
        matched.forEach((m) => groupedItemIds.add(m.id));
        clusters.push({
          clusterId: `doi-${doi}`,
          matchReason: 'EXACT_DOI',
          confidence: 1.0,
          items: matched.map((m) => ({
            id: m.id,
            title: m.title,
            doi: m.doi ?? undefined,
            year: m.year ?? undefined,
            authors: m.authors,
            citationKey: m.citationKey ?? undefined,
            collectionId: m.collectionId,
          })),
        });
      }
    });

    // ── Tier 2: Fuzzy Title + Year (+/-1) + First Author ──────────────────────
    const remainingItems = items.filter((item) => !groupedItemIds.has(item.id));

    const normalizeTitle = (t: string) =>
      (t || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();

    const getFirstAuthorFamily = (authors: string[]) => {
      if (!authors || authors.length === 0) return '';
      const first = (authors[0] || '').trim().toLowerCase();
      if (first.includes(',')) {
        return first.split(',')[0].trim();
      }
      const parts = first.split(/\s+/);
      return parts[parts.length - 1] || '';
    };

    const fuzzyBuckets = new Map<string, typeof remainingItems>();

    for (const item of remainingItems) {
      const normTitle = normalizeTitle(item.title);
      if (normTitle.length < 5) continue;

      const authorFamily = getFirstAuthorFamily(item.authors);
      const bucketKey = `${normTitle.substring(0, 32)}::${authorFamily}`;
      const bucket = fuzzyBuckets.get(bucketKey) || [];
      bucket.push(item);
      fuzzyBuckets.set(bucketKey, bucket);
    }

    fuzzyBuckets.forEach((bucket, key) => {
      if (bucket.length <= 1) return;

      const visited = new Set<string>();

      for (let i = 0; i < bucket.length; i++) {
        const itemA = bucket[i];
        if (visited.has(itemA.id) || groupedItemIds.has(itemA.id)) continue;

        const group = [itemA];
        for (let j = i + 1; j < bucket.length; j++) {
          const itemB = bucket[j];
          if (visited.has(itemB.id) || groupedItemIds.has(itemB.id)) continue;

          const yearA = itemA.year;
          const yearB = itemB.year;
          const yearMatch =
            yearA == null || yearB == null || Math.abs(yearA - yearB) <= 1;

          if (yearMatch) {
            group.push(itemB);
            visited.add(itemB.id);
          }
        }

        if (group.length > 1) {
          group.forEach((g) => groupedItemIds.add(g.id));
          clusters.push({
            clusterId: `fuzzy-${key.replace(/[^a-z0-9]/g, '-').substring(0, 24)}-${itemA.id.substring(0, 8)}`,
            matchReason: 'FUZZY_TITLE_YEAR_AUTHOR',
            confidence: 0.85,
            items: group.map((m) => ({
              id: m.id,
              title: m.title,
              doi: m.doi ?? undefined,
              year: m.year ?? undefined,
              authors: m.authors,
              citationKey: m.citationKey ?? undefined,
              collectionId: m.collectionId,
            })),
          });
        }
      }
    });

    return clusters;
  }

  /**
   * Non-destructive, atomic merge of duplicate items into a primary item.
   */
  async mergeDuplicates(workspaceId: string, dto: MergeDuplicatesDto) {
    if (!dto.primaryItemId) {
      throw new BadRequestException('primaryItemId is required');
    }
    if (!dto.duplicateItemIds || dto.duplicateItemIds.length === 0) {
      throw new BadRequestException('duplicateItemIds must not be empty');
    }

    const uniqueDupIds = Array.from(new Set(dto.duplicateItemIds));
    if (uniqueDupIds.includes(dto.primaryItemId)) {
      throw new BadRequestException(
        'primaryItemId cannot be included in duplicateItemIds',
      );
    }

    // Validate field selections against allowlist
    if (dto.fieldSelections) {
      for (const field of Object.keys(dto.fieldSelections)) {
        if (!ALLOWED_MERGE_METADATA_FIELDS.has(field)) {
          throw new BadRequestException(
            `Field "${field}" is not allowed in merge fieldSelections`,
          );
        }
      }
    }

    const allItemIds = [dto.primaryItemId, ...uniqueDupIds];
    const items = await this.prisma.catalogItem.findMany({
      where: {
        id: { in: allItemIds },
        workspaceId,
        deletedAt: null,
      },
      include: {
        attachments: true,
        collectionItems: true,
        itemTags: true,
        userStates: true,
      },
    });

    if (items.length !== allItemIds.length) {
      throw new NotFoundException(
        `One or more items do not exist, are already deleted, or belong to another workspace`,
      );
    }

    const primary = items.find((it) => it.id === dto.primaryItemId)!;
    const duplicates = items.filter((it) => it.id !== dto.primaryItemId);

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const now = new Date();

      // ── 1. Reassign Attachments to Primary ───────────────────────────────────
      await tx.catalogAttachment.updateMany({
        where: { catalogItemId: { in: uniqueDupIds } },
        data: { catalogItemId: primary.id },
      });

      // ── 2. Reassign Canonical Notes to Primary ──────────────────────────────
      await tx.note.updateMany({
        where: { itemId: { in: uniqueDupIds }, workspaceId },
        data: { itemId: primary.id },
      });

      // ── 3. Consolidate Tags & Labels ────────────────────────────────────────
      const allLabels = [
        ...(primary.labels || []),
        ...duplicates.flatMap((d) => d.labels || []),
      ];
      const allKeywords = [
        ...(primary.keywords || []),
        ...duplicates.flatMap((d) => d.keywords || []),
      ];
      const consolidatedLabels = normalizeTags(allLabels);
      const consolidatedKeywords = normalizeTags(allKeywords);

      // Reassign CatalogItemTag relations
      const primaryTagIds = new Set(primary.itemTags.map((t) => t.tagId));
      for (const dup of duplicates) {
        for (const itemTag of dup.itemTags) {
          if (!primaryTagIds.has(itemTag.tagId)) {
            await tx.catalogItemTag.upsert({
              where: {
                tagId_catalogItemId: {
                  tagId: itemTag.tagId,
                  catalogItemId: primary.id,
                },
              },
              create: {
                catalogItemId: primary.id,
                tagId: itemTag.tagId,
              },
              update: {},
            });
            primaryTagIds.add(itemTag.tagId);
          }
        }
      }
      await tx.catalogItemTag.deleteMany({
        where: { catalogItemId: { in: uniqueDupIds } },
      });

      // ── 4. Consolidate Collection Memberships ───────────────────────────────
      const primaryCollectionIds = new Set(
        primary.collectionItems.map((ci) => ci.collectionId),
      );
      for (const dup of duplicates) {
        for (const colItem of dup.collectionItems) {
          if (!primaryCollectionIds.has(colItem.collectionId)) {
            await tx.collectionItem.upsert({
              where: {
                collectionId_catalogItemId: {
                  collectionId: colItem.collectionId,
                  catalogItemId: primary.id,
                },
              },
              create: {
                catalogItemId: primary.id,
                collectionId: colItem.collectionId,
              },
              update: {},
            });
            primaryCollectionIds.add(colItem.collectionId);
          }
        }
      }
      await tx.collectionItem.deleteMany({
        where: { catalogItemId: { in: uniqueDupIds } },
      });

      // ── 5. Rewire Item Relations ────────────────────────────────────────────
      // Source rewiring
      await tx.itemRelation.updateMany({
        where: { sourceItemId: { in: uniqueDupIds } },
        data: { sourceItemId: primary.id },
      });
      // Target rewiring
      await tx.itemRelation.updateMany({
        where: { targetItemId: { in: uniqueDupIds } },
        data: { targetItemId: primary.id },
      });

      // Remove self-relations
      await tx.itemRelation.deleteMany({
        where: {
          sourceItemId: primary.id,
          targetItemId: primary.id,
        },
      });

      // Eliminate duplicate relation rows
      const allRelations = await tx.itemRelation.findMany({
        where: {
          OR: [{ sourceItemId: primary.id }, { targetItemId: primary.id }],
        },
      });
      const seenRelationKeys = new Set<string>();
      for (const rel of allRelations) {
        const key = `${rel.sourceItemId}::${rel.targetItemId}::${rel.relationType}`;
        if (seenRelationKeys.has(key)) {
          await tx.itemRelation.delete({ where: { id: rel.id } });
        } else {
          seenRelationKeys.add(key);
        }
      }

      // ── 6. Merge UserItemState per User ─────────────────────────────────────
      const allStates = await tx.userItemState.findMany({
        where: { itemId: { in: allItemIds } },
      });
      const statesByUser = new Map<string, typeof allStates>();
      for (const st of allStates) {
        const list = statesByUser.get(st.userId) || [];
        list.push(st);
        statesByUser.set(st.userId, list);
      }

      for (const [userId, userStateList] of statesByUser.entries()) {
        const dates = userStateList
          .map((s) => (s.lastReadAt ? new Date(s.lastReadAt).getTime() : 0))
          .filter((t) => t > 0);
        const lastReadAt =
          dates.length > 0 ? new Date(Math.max(...dates)) : null;

        let readStatus: 'unread' | 'reading' | 'completed' = 'unread';
        if (userStateList.some((s) => s.readStatus === 'completed')) {
          readStatus = 'completed';
        } else if (userStateList.some((s) => s.readStatus === 'reading')) {
          readStatus = 'reading';
        }

        const rating = Math.max(...userStateList.map((s) => s.rating || 0), 0);

        await tx.userItemState.upsert({
          where: {
            userId_itemId: {
              userId,
              itemId: primary.id,
            },
          },
          create: {
            userId,
            itemId: primary.id,
            isFavorite: false,
            readStatus,
            rating,
            lastReadAt,
          },
          update: {
            readStatus,
            rating,
            lastReadAt,
          },
        });
      }

      // Clean up duplicate items' UserItemStates
      await tx.userItemState.deleteMany({
        where: { itemId: { in: uniqueDupIds } },
      });

      // ── 7. Provenance & Alias Citation Keys ─────────────────────────────────
      let extraObj: Record<string, any> = {};
      try {
        extraObj = primary.extra ? JSON.parse(primary.extra) : {};
      } catch {
        extraObj = { rawExtra: primary.extra };
      }
      const existingAliases: string[] = Array.isArray(
        extraObj.mergedCitationKeys,
      )
        ? extraObj.mergedCitationKeys
        : [];
      const dupCitationKeys = duplicates
        .map((d) => d.citationKey)
        .filter((k): k is string =>
          Boolean(k?.trim() && k !== primary.citationKey),
        );
      extraObj.mergedCitationKeys = Array.from(
        new Set([...existingAliases, ...dupCitationKeys]),
      );

      // ── 8. Update Primary Item ──────────────────────────────────────────────
      const updatedPrimary = await tx.catalogItem.update({
        where: { id: primary.id },
        data: {
          ...(dto.fieldSelections || {}),
          labels: consolidatedLabels,
          keywords: consolidatedKeywords,
          extra: JSON.stringify(extraObj),
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: updatedPrimary.id,
        action: 'update',
        version: updatedPrimary.version,
        data: updatedPrimary,
      });

      await helpers.publishOutbox(
        workspaceId,
        primary.id,
        SYNC_EVENT_TYPES.ITEM_MERGED,
        {
          primaryItemId: primary.id,
          duplicateItemIds: uniqueDupIds,
          mergedCount: duplicates.length,
          mergedAt: now.toISOString(),
        },
      );

      // ── 9. Soft-Delete Duplicates with Merge Marker ─────────────────────────
      for (const dup of duplicates) {
        let dupExtra: Record<string, any> = {};
        try {
          dupExtra = dup.extra ? JSON.parse(dup.extra) : {};
        } catch {
          dupExtra = { rawExtra: dup.extra };
        }
        dupExtra.mergedIntoId = primary.id;
        dupExtra.mergedAt = now.toISOString();

        const softDeleted = await tx.catalogItem.update({
          where: { id: dup.id },
          data: {
            deletedAt: now,
            extra: JSON.stringify(dupExtra),
            version: { increment: 1 },
          },
        });

        await helpers.recordTombstone(workspaceId, {
          entityType: 'CatalogItem',
          entityId: dup.id,
        });

        await helpers.appendChange(workspaceId, {
          entityType: 'CatalogItem',
          entityId: dup.id,
          action: 'delete',
          version: softDeleted.version,
          data: softDeleted,
        });

        await helpers.publishOutbox(
          workspaceId,
          dup.id,
          'library.item.merged_into',
          {
            duplicateId: dup.id,
            primaryId: primary.id,
            workspaceId,
          },
        );
      }

      return {
        masterPaper: updatedPrimary,
        mergedCount: duplicates.length,
        softDeletedPaperIds: uniqueDupIds,
      };
    });
  }

  /**
   * Evaluates library metadata completeness and quality metrics.
   */
  async getQualityAudit(workspaceId: string) {
    const items = await this.prisma.catalogItem.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        title: true,
        doi: true,
        abstract: true,
        year: true,
        authors: true,
        publicationTitle: true,
      },
    });

    let totalScore = 0;
    let missingDoi = 0;
    let missingAbstract = 0;
    let missingYear = 0;

    for (const it of items) {
      let score = 0;
      if (it.title && it.title.length > 3) score += 25;
      if (it.authors && it.authors.length > 0) score += 25;
      if (it.year && it.year > 1900) score += 20;
      else missingYear += 1;
      if (it.doi) score += 15;
      else missingDoi += 1;
      if (it.abstract) score += 15;
      else missingAbstract += 1;

      totalScore += score;
    }

    const averageQualityScore =
      items.length > 0 ? Math.round(totalScore / items.length) : 100;

    return {
      totalItems: items.length,
      averageQualityScore,
      healthReport: {
        missingDoi,
        missingAbstract,
        missingYear,
      },
    };
  }

  /**
   * Synthesizes and extracts literature notes from PDF highlights and annotations.
   */
  async extractNotesFromAnnotations(
    workspaceId: string,
    paperId: string,
    userId: string,
  ) {
    const item = await this.catalogRepo.findById(workspaceId, paperId);
    if (!item) {
      throw new NotFoundException(
        `Paper ${paperId} not found in workspace ${workspaceId}`,
      );
    }

    const attachments = await this.prisma.catalogAttachment.findMany({
      where: { catalogItemId: paperId },
      select: { id: true, filename: true },
    });

    const attachmentIds = attachments.map((a: { id: string }) => a.id);
    const annotations =
      attachmentIds.length > 0
        ? await this.prisma.annotation.findMany({
            where: { attachmentId: { in: attachmentIds }, deletedAt: null },
            orderBy: [{ pageIndex: 'asc' }, { createdAt: 'asc' }],
          })
        : [];

    if (annotations.length === 0) {
      return {
        success: true,
        totalExtracted: 0,
        message: 'No annotations found for this paper',
      };
    }

    const lines: string[] = [
      `# Literature Notes: ${item.title || 'Untitled'}`,
      '',
      `**Authors:** ${Array.isArray(item.authors) ? item.authors.join(', ') : 'Unknown'}  `,
      `**Year:** ${item.year || 'N/A'} | **DOI:** ${item.doi || 'N/A'}`,
      '',
      '---',
      '',
      '## Extracted Highlights & Annotations',
      '',
    ];

    let currentPage = -1;
    for (const ann of annotations) {
      if (ann.pageIndex !== currentPage) {
        currentPage = ann.pageIndex;
        lines.push(`### Page ${currentPage + 1}`);
        lines.push('');
      }

      if (ann.quoteText) {
        lines.push(`> ${ann.quoteText.trim().replace(/\n+/g, '\n> ')}`);
        lines.push('');
      }

      if (ann.comment) {
        lines.push(`**Note:** ${ann.comment.trim()}`);
        lines.push('');
      }
    }

    const markdown = lines.join('\n');

    const note = await this.prisma.note.create({
      data: {
        workspaceId,
        itemId: paperId,
        title: `Literature Notes — ${item.title?.slice(0, 50) || 'Untitled'}`,
        contentMd: markdown,
        contentJson: {
          type: 'doc',
          content: [{ type: 'paragraph', text: markdown }],
        },
        createdById: userId || 'system',
        tags: ['literature-note', 'highlights'],
        version: 1,
      },
    });

    return {
      success: true,
      totalExtracted: annotations.length,
      literatureNote: note,
    };
  }
}
