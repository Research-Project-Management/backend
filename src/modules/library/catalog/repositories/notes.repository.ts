import { Prisma, ReadStatus, Annotation } from '@prisma/client';
import { isUuid, PrismaService } from '@/core';
import { normalizeProjectScopeId, SearchQueryEngine, ScopeSpecification, ActiveItemsSpecification, TrashItemsSpecification, ItemTypeSpecification, YearRangeSpecification, CollectionSpecification, TagSpecification, TagNamesSpecification, CompositeSpecification, AndSpecification, OrSpecification, NotSpecification, syncItemDenormalizedCountsInClient } from '@/modules/library/core';
import { Injectable, NotFoundException } from '@nestjs/common';
import { VersionMismatchException } from '@/modules/library/core/errors/domain.exception';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import { buildTipTapDocFromText, extractPlainTextFromTipTap } from '@/modules/library/core/domain/renamer.domain';
import { CreateNoteData, UpdateNoteData } from '@/modules/library/catalog/types/catalog.types';

export {
  ScopeSpecification,
  ActiveItemsSpecification,
  TrashItemsSpecification,
  ItemTypeSpecification,
  YearRangeSpecification,
  CollectionSpecification,
  TagSpecification,
  TagNamesSpecification,
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
  isUuid,
};

export interface ItemFilterOptions {
  view?:
    | 'all'
    | 'recent'
    | 'unfiled'
    | 'trash'
    | 'my-publications'
    | 'publications'
    | 'starred'
    | 'retracted';
  collectionId?: string;
  collectionIds?: string[];
  targetCollectionIds?: string[];
  tagId?: string;
  tag?: string;
  search?: string;
  hasFile?: boolean;
  hasNotes?: boolean;
  isRetracted?: boolean;
  onlyFlagged?: boolean;
  projectId?: string;
  itemType?: string;
  type?: string;
  fromYear?: number;
  toYear?: number;
  readStatus?: string;
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;
  userId?: string;
  ids?: string[];
}

/**
 * Constructs comprehensive search filters covering Zotero fields:
 * - 'title_creator_year': title, year, and contributor names
 * - 'fields_tags': all bibliographic fields + tags
 * - 'everything' (default): all bibliographic fields + tags + notes + attachments + fulltext
 */
export function buildItemSearchCondition(
  search: string,
  searchMode?: string,
): Prisma.ItemWhereInput[] {
  const effectiveMode =
    searchMode === 'title_creator_year'
      ? 'title_creator_year'
      : searchMode === 'everything'
        ? 'everything'
        : 'fields_tags';
  return SearchQueryEngine.buildComprehensiveItemSearchClauses(
    search,
    effectiveMode,
  ) as Prisma.ItemWhereInput[];
}

export class ItemWhereSpecification extends CompositeSpecification<
  Record<string, unknown>,
  Prisma.ItemWhereInput
> {
  constructor(
    private readonly clause: Prisma.ItemWhereInput,
    private readonly predicate?: (item: Record<string, unknown>) => boolean,
  ) {
    super();
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    return this.clause;
  }

  isSatisfiedBy(item: Record<string, unknown>): boolean {
    return this.predicate ? this.predicate(item) : true;
  }
}

function composeAndSpecifications(
  specs: ItemWhereSpecification[],
): Prisma.ItemWhereInput[] {
  if (specs.length === 0) return [];
  if (specs.length === 1) return [specs[0].toPrismaWhere()];
  const combined = specs
    .slice(1)
    .reduce<
      CompositeSpecification<Record<string, unknown>, Prisma.ItemWhereInput>
    >((acc, spec) => acc.and(spec), specs[0])
    .toPrismaWhere();
  if (combined && Array.isArray(combined.AND)) {
    return combined.AND;
  }
  return [combined];
}

/**
 * Builds a shared CatalogItem WHERE clause from the common filter options.
 * Uses CompositeSpecification / AndSpecification so multiple tag or state predicates
 * compose into `{ AND: [...] }` without overwriting each other.
 */
export function buildItemWhereClause(
  userId: string,
  options: ItemFilterOptions,
): Prisma.ItemWhereInput {
  const view = options.view ?? 'all';
  const validProjectId = normalizeProjectScopeId(options.projectId);
  const scopeSpec = new ScopeSpecification(
    userId,
    validProjectId && isUuid(validProjectId) ? validProjectId : null,
  );
  const where: Prisma.ItemWhereInput = {
    ...(scopeSpec.toPrismaWhere() as Prisma.ItemWhereInput),
  };

  const andSpecs: ItemWhereSpecification[] = [];
  const stateSpecs: ItemWhereSpecification[] = [];
  const tagSpecs: ItemWhereSpecification[] = [];

  if (options.ids && options.ids.length > 0) {
    const validIds = options.ids.filter(isUuid);
    if (validIds.length > 0) {
      andSpecs.push(
        new ItemWhereSpecification({
          id: { in: validIds },
        }),
      );
    }
  }

  if (view === 'trash') {
    where.deletedAt = { not: null };
  } else {
    where.deletedAt = null;
    if (view === 'unfiled') {
      where.collectionItems = { none: { collection: { deletedAt: null } } };
    } else if (view === 'my-publications' || view === 'publications') {
      andSpecs.push(
        new ItemWhereSpecification({
          OR: [
            { metadata: { path: ['isMyPublication'], equals: true } },
            { publications: { some: { userId } } },
          ],
        }),
      );
    } else if (view === 'starred') {
      stateSpecs.push(
        new ItemWhereSpecification({
          states: { some: { userId, isStarred: true } },
        }),
      );
    } else if (view === 'retracted') {
      andSpecs.push(
        new ItemWhereSpecification({
          OR: [
            { isRetracted: true },
            { metadata: { path: ['isRetracted'], equals: true } },
          ],
        }),
      );
    }
  }

  if (options.isRetracted !== undefined && view !== 'retracted') {
    if (options.isRetracted) {
      andSpecs.push(
        new ItemWhereSpecification({
          OR: [
            { isRetracted: true },
            { metadata: { path: ['isRetracted'], equals: true } },
          ],
        }),
      );
    } else {
      andSpecs.push(
        new ItemWhereSpecification({
          NOT: {
            OR: [
              { isRetracted: true },
              { metadata: { path: ['isRetracted'], equals: true } },
            ],
          },
        }),
      );
    }
  }

  if (options.onlyFlagged) {
    stateSpecs.push(
      new ItemWhereSpecification({
        states: {
          some: {
            userId,
            isStarred: true,
          },
        },
      }),
    );
  }

  if (options.hasFile !== undefined) {
    where.hasFile = options.hasFile;
  }

  if (options.hasNotes !== undefined) {
    if (options.hasNotes) {
      where.noteCount = { gt: 0 };
    } else {
      where.noteCount = 0;
    }
  }

  const targetCollectionIds =
    options.targetCollectionIds || options.collectionIds;
  if (targetCollectionIds && targetCollectionIds.length > 0) {
    where.collectionItems = new CollectionSpecification(
      targetCollectionIds,
    ).toPrismaWhere().collectionItems as Prisma.CollectionItemListRelationFilter;
  } else if (options.collectionId) {
    where.collectionItems = new CollectionSpecification(
      options.collectionId,
    ).toPrismaWhere().collectionItems as Prisma.CollectionItemListRelationFilter;
  }

  if (options.tagId) {
    tagSpecs.push(
      new ItemWhereSpecification(
        new TagSpecification(options.tagId).toPrismaWhere() as Prisma.ItemWhereInput,
      ),
    );
  }

  if (options.tag) {
    const tagNamesWhere = new TagNamesSpecification(options.tag).toPrismaWhere();
    if (tagNamesWhere.itemTags) {
      tagSpecs.push(
        new ItemWhereSpecification(tagNamesWhere as Prisma.ItemWhereInput),
      );
    }
  }

  if (tagSpecs.length === 1) {
    where.itemTags = tagSpecs[0].toPrismaWhere().itemTags;
  } else if (tagSpecs.length > 1) {
    andSpecs.push(...tagSpecs);
  }

  const itemType = options.itemType || options.type;
  if (itemType) {
    const itemTypeWhere = new ItemTypeSpecification(itemType).toPrismaWhere();
    if (itemTypeWhere.itemType !== undefined) {
      where.itemType = itemTypeWhere.itemType as Prisma.StringFilter | string;
    }
  }

  if (options.fromYear !== undefined || options.toYear !== undefined) {
    where.year = new YearRangeSpecification(
      options.fromYear,
      options.toYear,
    ).toPrismaWhere().year as Prisma.IntNullableFilter;
  }

  if (options.readStatus && options.readStatus !== 'all') {
    const validStatuses: ReadStatus[] = ['unread', 'reading', 'completed'];
    const statuses = options.readStatus
      .split(',')
      .map((s) => (s.trim() === 'read' ? 'completed' : s.trim()))
      .filter((s): s is ReadStatus => validStatuses.includes(s as ReadStatus));
    if (statuses.length > 0) {
      if (statuses.includes('unread')) {
        andSpecs.push(
          new ItemWhereSpecification({
            OR: [
              { states: { none: { userId } } },
              {
                states: {
                  some: {
                    userId,
                    readStatus:
                      statuses.length > 1 ? { in: statuses } : 'unread',
                  },
                },
              },
            ],
          }),
        );
      } else {
        stateSpecs.push(
          new ItemWhereSpecification({
            states: {
              some: {
                userId,
                readStatus:
                  statuses.length > 1 ? { in: statuses } : statuses[0],
              },
            },
          }),
        );
      }
    }
  }

  if (stateSpecs.length === 1) {
    where.states = stateSpecs[0].toPrismaWhere().states;
  } else if (stateSpecs.length > 1) {
    andSpecs.push(...stateSpecs);
  }

  if (options.search) {
    andSpecs.push(
      new ItemWhereSpecification({
        OR: buildItemSearchCondition(options.search, options.searchMode),
      }),
    );
  }

  const andConditions = composeAndSpecifications(andSpecs);
  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}

export type { CreateNoteData, UpdateNoteData };

@Injectable()
export class NotesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  private buildScopeWhere(userId: string, projectId?: string) {
    const validProjectId = normalizeProjectScopeId(projectId);
    return validProjectId && isUuid(validProjectId)
      ? { projectId: validProjectId }
      : { userId, projectId: null };
  }

  async findMany(
    userId: string,
    itemId?: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
    limit?: number,
  ) {
    const client = this.getClient(tx);
    const where: Prisma.NoteWhereInput = {
      ...this.buildScopeWhere(userId, projectId),
      ...(itemId !== undefined ? { itemId } : {}),
      deletedAt: null,
    };

    return client.note.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit ?? 500,
    });
  }

  async findById(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    return client.note.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });
  }

  async syncItemNoteCount(
    itemId: string | null | undefined,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!itemId || !isUuid(itemId)) return;
    await syncItemDenormalizedCountsInClient(this.getClient(tx), itemId, {
      notes: true,
    });
  }

  async create(
    userId: string,
    data: CreateNoteData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    let effectiveProjectId = normalizeProjectScopeId(data.projectId) ?? null;

    if (data.itemId) {
      const parentItem = await client.item.findFirst({
        where: effectiveProjectId
          ? { id: data.itemId, projectId: effectiveProjectId, deletedAt: null }
          : { id: data.itemId, userId, projectId: null, deletedAt: null },
        select: { id: true, projectId: true },
      });
      if (!parentItem) {
        throw new NotFoundException(
          `Target item ${data.itemId} not found or has been deleted`,
        );
      }
      if (!effectiveProjectId && parentItem.projectId) {
        effectiveProjectId = parentItem.projectId;
      }
    }
    const effectiveContentMd =
      data.contentMd !== undefined && data.contentMd !== ''
        ? data.contentMd
        : data.contentJson !== undefined && data.contentJson !== null
          ? extractPlainTextFromTipTap(data.contentJson)
          : (data.contentMd ?? '');
    const created = await client.note.create({
      data: {
        userId,
        projectId: effectiveProjectId,
        itemId: data.itemId ?? null,
        title: data.title ?? 'Untitled Note',
        contentJson:
          data.contentJson !== undefined && data.contentJson !== null
            ? (data.contentJson as Prisma.InputJsonValue)
            : (buildTipTapDocFromText(effectiveContentMd) as Prisma.InputJsonValue),
        contentMd: effectiveContentMd,
        tags: data.tags
          ? normalizeTags(data.tags, { allowManualAcademicTerms: true })
          : [],
        createdById: data.createdById || userId,
        version: 1,
      },
    });
    await this.syncItemNoteCount(created.itemId ?? data.itemId, tx);
    return created;
  }

  async update(
    userId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateNoteData,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const existing = await client.note.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    const effectiveExpectedVersion = expectedVersion ?? data?.expectedVersion;
    const validUpdatedById = isUuid(userId) ? userId : undefined;
    const resolvedContentMd =
      data.contentMd !== undefined
        ? data.contentMd
        : data.contentJson !== undefined
          ? data.contentJson !== null
            ? extractPlainTextFromTipTap(data.contentJson)
            : ''
          : existing.contentMd;
    const updatePayload = {
      ...(validUpdatedById ? { updatedById: validUpdatedById } : {}),
      title: data.title ?? existing.title,
      contentJson:
        data.contentJson !== undefined
          ? data.contentJson !== null
            ? (data.contentJson as Prisma.InputJsonValue)
            : Prisma.DbNull
          : data.contentMd !== undefined
            ? (buildTipTapDocFromText(data.contentMd) as Prisma.InputJsonValue)
            : undefined,
      contentMd: resolvedContentMd,
      tags:
        data.tags !== undefined
          ? normalizeTags(data.tags, { allowManualAcademicTerms: true })
          : existing.tags,
    };

    if (effectiveExpectedVersion !== undefined) {
      const affected = await client.note.updateMany({
        where: {
          id,
          ...scopeWhere,
          deletedAt: null,
          version: effectiveExpectedVersion,
        },
        data: {
          ...updatePayload,
          version: { increment: 1 },
        },
      });

      if (affected.count === 0) {
        const fresh = await client.note.findUnique({
          where: { id },
          select: { version: true },
        });
        throw new VersionMismatchException({
          aggregateType: 'Note',
          entityId: id,
          currentVersion: fresh?.version ?? existing.version,
          providedVersion: effectiveExpectedVersion,
        });
      }

      return {
        ...existing,
        ...updatePayload,
        contentJson:
          updatePayload.contentJson === Prisma.DbNull
            ? null
            : (updatePayload.contentJson ?? existing.contentJson),
        version: (existing.version ?? 1) + 1,
        updatedAt: new Date(),
      };
    }

    return client.note.update({
      where: { id },
      data: {
        ...updatePayload,
        version: { increment: 1 },
      },
    });
  }

  async softDelete(
    userId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const existing = await client.note.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });

    const result = await client.note.updateMany({
      where: {
        id,
        ...scopeWhere,
        deletedAt: null,
        ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
      },
      data: {
        deletedAt: new Date(),
        ...(isUuid(userId) ? { deletedById: userId } : {}),
        version: { increment: 1 },
      },
    });

    if (result.count === 0 && expectedVersion !== undefined && existing) {
      const fresh = await client.note.findUnique?.({
        where: { id },
        select: { version: true },
      });
      throw new VersionMismatchException({
        aggregateType: 'Note',
        entityId: id,
        currentVersion: fresh?.version ?? existing.version,
        providedVersion: expectedVersion,
      });
    }

    if (result.count > 0 && existing?.itemId) {
      await this.syncItemNoteCount(existing.itemId, tx);
    }

    return result.count > 0;
  }

  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const cleanSourceIds = sourceItemIds.filter((id) => id !== targetItemId);
    if (cleanSourceIds.length === 0) return;
    const client = this.getClient(tx);
    await client.note.updateMany({
      where: { itemId: { in: cleanSourceIds } },
      data: { itemId: targetItemId },
    });
    await Promise.all([
      ...cleanSourceIds.map((sourceId) => this.syncItemNoteCount(sourceId, tx)),
      this.syncItemNoteCount(targetItemId, tx),
    ]);
  }

  async createLiteratureNote(
    userId: string,
    itemId: string,
    content: string,
    source?: string,
    tx?: Prisma.TransactionClient,
    projectId?: string | null,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    const client = this.getClient(tx);

    let effectiveProjectId = normalizeProjectScopeId(projectId) ?? null;
    if (!effectiveProjectId && typeof client.item?.findFirst === 'function') {
      const parentItem = await client.item.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { projectId: true },
      });
      if (parentItem?.projectId) {
        effectiveProjectId = parentItem.projectId;
      }
    }

    const existing = await client.note.findFirst({
      where: {
        ...(effectiveProjectId
          ? { projectId: effectiveProjectId }
          : { userId, projectId: null }),
        itemId,
        contentMd: trimmed,
        deletedAt: null,
      },
    });
    if (existing) return;

    await client.note.create({
      data: {
        userId,
        projectId: effectiveProjectId,
        itemId,
        title: source ? `Imported Note (${source})` : 'Imported Note',
        contentMd: trimmed,
        contentJson: buildTipTapDocFromText(trimmed) as Prisma.InputJsonValue,
        createdById: userId,
        tags: normalizeTags(['imported', ...(source ? [source] : [])]),
        version: 1,
      },
    });
    await this.syncItemNoteCount(itemId, tx);
  }

  async findItemAnnotations(
    itemId: string,
    opts?: {
      attachmentId?: string;
      annotationIds?: string[];
      userId?: string;
      projectId?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<Annotation[]> {
    const client = this.getClient(tx);
    const cleanAnnotationIds = Array.isArray(opts?.annotationIds)
      ? opts.annotationIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    const itemScopeWhere = opts?.userId
      ? this.buildScopeWhere(opts.userId, opts.projectId)
      : {};
    return client.annotation.findMany({
      where: {
        ...(opts?.attachmentId ? { attachmentId: opts.attachmentId } : {}),
        ...(cleanAnnotationIds.length > 0
          ? { id: { in: cleanAnnotationIds } }
          : {}),
        attachment: {
          itemId,
          deletedAt: null,
          ...(Object.keys(itemScopeWhere).length > 0
            ? {
                item: {
                  ...itemScopeWhere,
                  deletedAt: null,
                },
              }
            : {}),
        },
        deletedAt: null,
      },
      orderBy: [
        { pageIndex: 'asc' },
        { annotationSortIndex: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }
}
