import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import { TransactionService } from '../outbox/transaction.service';
import { TagsService } from '../tags/tags.service';
import { CollectionsService } from '../collections/collections.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { NotesService } from '../notes/notes.service';
import { ReadingService } from '../reading/reading.service';
import {
  MergeDuplicatesDto,
  DuplicateClusterResult,
  ALLOWED_MERGE_METADATA_FIELDS,
} from './curation.dto';
import { LIBRARY_EVENT_TYPES } from '../outbox/outbox.events';
import { ItemsMapper } from '../items/items.mapper';

@Injectable()
export class DuplicateService {
  private readonly logger = new Logger(DuplicateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: TransactionService,
    private readonly tagsService: TagsService,
    private readonly collectionsService: CollectionsService,
    private readonly attachmentsService: AttachmentsService,
    private readonly notesService: NotesService,
    private readonly readingService: ReadingService,
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  /**
   * Scans active items in workspace and clusters duplicate candidates.
   * Tier 1: Exact normalized DOI.
   * Tier 2: Normalized title + publication year (+/- 1) + first author family name.
   */
  async detectDuplicates(
    workspaceId: string,
  ): Promise<DuplicateClusterResult[]> {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const items = await this.prisma.catalogItem.findMany({
      where: { workspaceId: wsId, deletedAt: null },
      select: {
        id: true,
        title: true,
        doi: true,
        isbn: true,
        issn: true,
        pmid: true,
        citationKey: true,
        year: true,
        contributors: {
          where: { creatorType: 'author' },
          select: {
            fullName: true,
            firstName: true,
            lastName: true,
            orderIndex: true,
          },
          orderBy: { orderIndex: 'asc' },
        },
      },
    });

    const getItemAuthors = (item: any): string[] => {
      const fromContributors = item.contributors
        ?.map((c: any) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim())
        .filter(Boolean);
      if (fromContributors && fromContributors.length > 0) return fromContributors;
      return [];
    };

    const clusters: DuplicateClusterResult[] = [];
    const groupedItemIds = new Set<string>();

    // ── Tier 1: Exact normalized DOI ─────────────────────────────────────────────
    const doiMap = new Map<string, any[]>();
    for (const item of items) {
      if (!item.doi) continue;
      const cleanDoi = item.doi.toLowerCase().trim();
      const existing = doiMap.get(cleanDoi) || [];
      existing.push(item);
      doiMap.set(cleanDoi, existing);
    }

    doiMap.forEach((matchedItems, doi) => {
      if (matchedItems.length > 1) {
        matchedItems.forEach((m: any) => groupedItemIds.add(m.id));
        clusters.push({
          clusterId: `doi-${doi.replace(/[^a-z0-9]/g, '-')}`,
          matchReason: 'EXACT_DOI',
          confidence: 1.0,
          items: matchedItems.map((m: any) => ({
            id: m.id,
            title: m.title,
            doi: m.doi ?? undefined,
            year: m.year ?? undefined,
            authors: getItemAuthors(m),
            citationKey: m.citationKey ?? undefined,
          })),
        });
      }
    });

    // ── Tier 2: Fuzzy Title + Year (+/-1) + First Author ─────────────────────────
    const remainingItems = items.filter((item: any) => !groupedItemIds.has(item.id));

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

      const authorFamily = getFirstAuthorFamily(getItemAuthors(item));
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
              authors: getItemAuthors(m),
              citationKey: m.citationKey ?? undefined,
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
    const wsId = await this.resolveWorkspaceId(workspaceId);
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
        workspaceId: wsId,
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

    const primary = items.find((it: any) => it.id === dto.primaryItemId)!;
    const duplicates = items.filter((it: any) => it.id !== dto.primaryItemId);

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const now = new Date();

      // ── 1. Reassign Attachments to Primary (Delegated to AttachmentsService) ──
      await this.attachmentsService.reassignToItem(uniqueDupIds, primary.id, tx);

      // ── 2. Reassign Canonical Notes to Primary (Delegated to NotesService) ────
      await this.notesService.reassignToItem(uniqueDupIds, primary.id, tx);

      // ── 3. Consolidate Tags & Labels (Delegated to TagsService) ───────────────
      await this.tagsService.mergeTagsToItem(tx, uniqueDupIds, primary.id);

      // ── 4. Consolidate Collection Memberships (Delegated to CollectionsService)
      await this.collectionsService.transferItemMemberships(uniqueDupIds, primary.id, tx);

      // ── 5. Rewire Item Relations ──────────────────────────────────────────────
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

      // ── 6. Merge User States (Delegated to ReadingService) ────────────────────
      await this.readingService.transferUserItemStates(tx, uniqueDupIds, primary.id);

      // ── 7. Provenance & Alias Citation Keys ──────────────────────────────────
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
        .map((d: any) => d.citationKey)
        .filter((k: any): k is string =>
          Boolean(k?.trim() && k !== primary.citationKey),
        );
      extraObj.mergedCitationKeys = Array.from(
        new Set([...existingAliases, ...dupCitationKeys]),
      );

      // ── 8. Update Primary Item ───────────────────────────────────────────────
      const updatedPrimary = await tx.catalogItem.update({
        where: { id: primary.id },
        data: {
          ...(dto.fieldSelections || {}),
          extra: JSON.stringify(extraObj),
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(wsId, {
        entityType: 'CatalogItem',
        entityId: updatedPrimary.id,
        action: 'update',
        version: updatedPrimary.version,
        data: updatedPrimary,
      });

      await helpers.publishOutbox(
        wsId,
        primary.id,
        LIBRARY_EVENT_TYPES.ITEM_MERGED,
        {
          primaryItemId: primary.id,
          duplicateItemIds: uniqueDupIds,
          mergedCount: duplicates.length,
          mergedAt: now.toISOString(),
        },
      );

      // ── 9. Soft-Delete Duplicates with Merge Marker ──────────────────────────
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

        await helpers.recordTombstone(wsId, {
          entityType: 'CatalogItem',
          entityId: dup.id,
        });

        await helpers.appendChange(wsId, {
          entityType: 'CatalogItem',
          entityId: dup.id,
          action: 'delete',
          version: softDeleted.version,
          data: softDeleted,
        });

        await helpers.publishOutbox(wsId, dup.id, 'library.item.merged_into', {
          duplicateId: dup.id,
          primaryId: primary.id,
          workspaceId: wsId,
        });
      }

      // Reload primary item with full relations so response is complete & normalized
      const reloadedPrimary = await tx.catalogItem.findUnique({
        where: { id: primary.id },
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
          identifiers: true,
          collectionItems: { include: { collection: true } },
          itemTags: { include: { tag: true } },
          notesList: { where: { deletedAt: null } },
          attachments: { include: { revisions: true } },
        },
      });

      return {
        primaryItem: ItemsMapper.toDomain(
          reloadedPrimary ?? updatedPrimary,
        ),
        mergedCount: duplicates.length,
        softDeletedItemIds: uniqueDupIds,
      };
    });
  }
}

export const CatalogDuplicateService = DuplicateService;
export type CatalogDuplicateService = DuplicateService;
