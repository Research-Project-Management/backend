import { Prisma } from '@prisma/client';
import { IUnitOfWork, TransactionHelpers } from '../ports/catalog.port';
import { ConfigurationException } from '../errors/domain.exception';

export type QueryCriteria = Record<string, unknown>;

/**
 * GoF / DDD Specification Pattern Interface.
 */
export interface ISpecification<T = unknown, TWhere = QueryCriteria> {
  toPrismaWhere(): TWhere;
  isSatisfiedBy(item: T): boolean;
  and(other: ISpecification<T, TWhere>): ISpecification<T, TWhere>;
  or(other: ISpecification<T, TWhere>): ISpecification<T, TWhere>;
  not(): ISpecification<T, TWhere>;
}

export abstract class CompositeSpecification<T = unknown, TWhere = QueryCriteria> implements ISpecification<T, TWhere> {
  abstract toPrismaWhere(): TWhere;
  abstract isSatisfiedBy(item: T): boolean;

  and(other: ISpecification<T, TWhere>): ISpecification<T, TWhere> {
    return new AndSpecification<T, TWhere>(this, other);
  }
  or(other: ISpecification<T, TWhere>): ISpecification<T, TWhere> {
    return new OrSpecification<T, TWhere>(this, other);
  }
  not(): ISpecification<T, TWhere> {
    return new NotSpecification<T, TWhere>(this);
  }
}

function isEmptyWhereObject(where: unknown): boolean {
  return !where || (typeof where === 'object' && !Array.isArray(where) && Object.keys(where).length === 0);
}

function extractCombinatorClauses(where: unknown, operator: 'AND' | 'OR'): unknown[] {
  if (where && typeof where === 'object' && !Array.isArray(where)) {
    const rec = where as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1 && keys[0] === operator && Array.isArray(rec[operator])) {
      return rec[operator] as unknown[];
    }
  }
  return [where];
}

export class AndSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> extends CompositeSpecification<T, TWhere> {
  constructor(
    private readonly left: ISpecification<T, TWhere>,
    private readonly right: ISpecification<T, TWhere>,
  ) {
    super();
  }

  toPrismaWhere(): TWhere {
    const leftWhere = this.left.toPrismaWhere();
    const rightWhere = this.right.toPrismaWhere();
    const leftEmpty = isEmptyWhereObject(leftWhere);
    const rightEmpty = isEmptyWhereObject(rightWhere);

    if (leftEmpty && rightEmpty) {
      return {} as unknown as TWhere;
    }
    if (leftEmpty) {
      return rightWhere;
    }
    if (rightEmpty) {
      return leftWhere;
    }

    return {
      AND: [
        ...extractCombinatorClauses(leftWhere, 'AND'),
        ...extractCombinatorClauses(rightWhere, 'AND'),
      ],
    } as unknown as TWhere;
  }

  isSatisfiedBy(item: T): boolean {
    return (
      (typeof this.left.isSatisfiedBy === 'function'
        ? this.left.isSatisfiedBy(item)
        : true) &&
      (typeof this.right.isSatisfiedBy === 'function'
        ? this.right.isSatisfiedBy(item)
        : true)
    );
  }
}

export class OrSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> extends CompositeSpecification<T, TWhere> {
  constructor(
    private readonly left: ISpecification<T, TWhere>,
    private readonly right: ISpecification<T, TWhere>,
  ) {
    super();
  }

  toPrismaWhere(): TWhere {
    const leftWhere = this.left.toPrismaWhere();
    const rightWhere = this.right.toPrismaWhere();
    const leftEmpty = isEmptyWhereObject(leftWhere);
    const rightEmpty = isEmptyWhereObject(rightWhere);

    if (leftEmpty && rightEmpty) {
      return {} as unknown as TWhere;
    }
    if (leftEmpty) {
      return rightWhere;
    }
    if (rightEmpty) {
      return leftWhere;
    }

    return {
      OR: [
        ...extractCombinatorClauses(leftWhere, 'OR'),
        ...extractCombinatorClauses(rightWhere, 'OR'),
      ],
    } as unknown as TWhere;
  }

  isSatisfiedBy(item: T): boolean {
    return (
      (typeof this.left.isSatisfiedBy === 'function'
        ? this.left.isSatisfiedBy(item)
        : false) ||
      (typeof this.right.isSatisfiedBy === 'function'
        ? this.right.isSatisfiedBy(item)
        : false)
    );
  }
}

export class NotSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> extends CompositeSpecification<T, TWhere> {
  constructor(private readonly wrapped: ISpecification<T, TWhere>) {
    super();
  }

  toPrismaWhere(): TWhere {
    return {
      NOT: this.wrapped.toPrismaWhere(),
    } as unknown as TWhere;
  }

  isSatisfiedBy(item: T): boolean {
    return typeof this.wrapped.isSatisfiedBy === 'function'
      ? !this.wrapped.isSatisfiedBy(item)
      : false;
  }
}

/**
 * Scope normalization and user/project resolution helpers.
 *
 * Pure Shared Kernel primitive used across Library bounded contexts
 * (Catalog, Search, Sync, Ingestion, Extraction, Citation) to distinguish
 * collaborative project scope from personal user library scope.
 */
const PERSONAL_SCOPE_ALIASES = new Set(['user', 'me', 'personal', 'none', 'undefined', 'null']);

export function isProjectScopeId(projectId?: string | null): projectId is string {
  if (!projectId || typeof projectId !== 'string') return false;
  const trimmed = projectId.trim();
  return trimmed.length > 0 && !PERSONAL_SCOPE_ALIASES.has(trimmed.toLowerCase());
}

export function normalizeProjectScopeId(projectId?: string | null): string | undefined {
  return isProjectScopeId(projectId) ? projectId.trim() : undefined;
}

export function resolveCanonicalScopeKey(scope: {
  userId?: string | null;
  projectId?: string | null;
}): string {
  const validProjectId = normalizeProjectScopeId(scope.projectId);
  if (validProjectId) return `proj:${validProjectId}`;
  const cleanUserId = typeof scope.userId === 'string' ? scope.userId.trim() : '';
  if (!cleanUserId) {
    throw new ConfigurationException('Scope resolution requires either a valid projectId or userId');
  }
  return `user:${cleanUserId}`;
}

export function resolveSpaceId(scope: {
  userId?: string | null;
  projectId?: string | null;
  spaceId?: string | null;
}): string {
  if (scope.spaceId && scope.spaceId.trim()) return scope.spaceId.trim();
  const validProjectId = normalizeProjectScopeId(scope.projectId);
  if (validProjectId) return validProjectId;
  const cleanUserId = typeof scope.userId === 'string' ? scope.userId.trim() : '';
  if (!cleanUserId) {
    throw new ConfigurationException('Scope resolution requires either a valid projectId or userId');
  }
  return cleanUserId;
}

/**
 * Cycle-safe O(V + E) Breadth-First Search (BFS) descendant collection ID resolver.
 * Shared across Catalog and Search bounded contexts.
 */
export function collectDescendantCollectionIds(
  collections: ReadonlyArray<{ id: string; parentId?: string | null }>,
  rootId: string,
): string[] {
  const childrenMap = new Map<string, string[]>();
  for (const c of collections) {
    if (c.parentId) {
      let existing = childrenMap.get(c.parentId);
      if (!existing) {
        existing = [];
        childrenMap.set(c.parentId, existing);
      }
      existing.push(c.id);
    }
  }

  const visited = new Set<string>([rootId]);
  const descendants: string[] = [];
  const queue: string[] = [];

  const rootChildren = childrenMap.get(rootId);
  if (rootChildren) {
    for (const childId of rootChildren) {
      if (!visited.has(childId)) {
        visited.add(childId);
        queue.push(childId);
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    descendants.push(current);
    const nextChildren = childrenMap.get(current);
    if (nextChildren) {
      for (const childId of nextChildren) {
        if (!visited.has(childId)) {
          visited.add(childId);
          queue.push(childId);
        }
      }
    }
  }

  return descendants;
}

/**
 * ScopeSpecification: Enforces user & project scope isolation.
 * Resolves to projectId for user projects, or userId for personal user library.
 */
export class ScopeSpecification extends CompositeSpecification<
  unknown,
  QueryCriteria
> {
  constructor(
    public readonly userId: string,
    public readonly projectId?: string | null,
  ) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    return { spaceId: resolveSpaceId({ userId: this.userId, projectId: this.projectId }) };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const expectedSpaceId = resolveSpaceId({ userId: this.userId, projectId: this.projectId });
    if (typeof rec.spaceId === 'string') {
      return rec.spaceId === expectedSpaceId;
    }
    if (isProjectScopeId(this.projectId)) {
      return rec.projectId === this.projectId.trim();
    }
    return (
      rec.userId === this.userId && (!rec.projectId || rec.projectId === null)
    );
  }
}

/**
 * ActiveItemsSpecification: Filters out soft-deleted items.
 */
export class ActiveItemsSpecification extends CompositeSpecification {
  toPrismaWhere(): QueryCriteria {
    return { deletedAt: null };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    return rec.deletedAt === null || rec.deletedAt === undefined;
  }
}

/**
 * TrashItemsSpecification: Filters only soft-deleted items in the trash.
 */
export class TrashItemsSpecification extends CompositeSpecification {
  toPrismaWhere(): QueryCriteria {
    return { deletedAt: { not: null } };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    return rec.deletedAt !== null && rec.deletedAt !== undefined;
  }
}

const CANONICAL_ITEM_TYPE_BY_LOWER: Readonly<Record<string, string>> = {
  journalarticle: 'journalArticle',
  magazinearticle: 'magazineArticle',
  newspaperarticle: 'newspaperArticle',
  book: 'book',
  booksection: 'bookSection',
  conferencepaper: 'conferencePaper',
  thesis: 'thesis',
  preprint: 'preprint',
  report: 'report',
  webpage: 'webpage',
  patent: 'patent',
  computerprogram: 'computerProgram',
  software: 'computerProgram',
  dataset: 'dataset',
  presentation: 'presentation',
  manuscript: 'manuscript',
  document: 'document',
  statute: 'statute',
  case: 'case',
  hearing: 'hearing',
  bill: 'bill',
  treaty: 'treaty',
  standard: 'standard',
  encyclopediaarticle: 'encyclopediaArticle',
  dictionaryentry: 'dictionaryEntry',
  blogpost: 'blogPost',
  forumpost: 'forumPost',
  instantmessage: 'instantMessage',
  email: 'email',
  letter: 'letter',
  interview: 'interview',
  film: 'film',
  video: 'videoRecording',
  videorecording: 'videoRecording',
  audiorecording: 'audioRecording',
  podcast: 'podcast',
  radiobroadcast: 'radioBroadcast',
  tvbroadcast: 'tvBroadcast',
  artwork: 'artwork',
  map: 'map',
};

function normalizeSpecificationItemType(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return CANONICAL_ITEM_TYPE_BY_LOWER[trimmed.toLowerCase()] || trimmed;
}

/**
 * ItemTypeSpecification: Filters by bibliographic item type (journalArticle, book, etc.).
 */
export class ItemTypeSpecification extends CompositeSpecification {
  private readonly itemTypes: string[];
  private readonly lowerItemTypesSet: Set<string>;

  constructor(itemTypes: string | string[]) {
    super();
    const rawList = Array.isArray(itemTypes) ? itemTypes : [itemTypes];
    const expanded = rawList
      .flatMap((t) => String(t).split(','))
      .map((t) => normalizeSpecificationItemType(t))
      .filter(Boolean);
    this.itemTypes = Array.from(new Set(expanded));
    this.lowerItemTypesSet = new Set(
      this.itemTypes.map((t) => t.toLowerCase()),
    );
  }

  toPrismaWhere(): QueryCriteria {
    if (this.itemTypes.length === 0) return {};
    if (this.itemTypes.length === 1) {
      return { itemType: this.itemTypes[0] };
    }
    return { itemType: { in: this.itemTypes } };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    return (
      typeof rec.itemType === 'string' &&
      this.lowerItemTypesSet.has(rec.itemType.toLowerCase())
    );
  }
}

/**
 * YearRangeSpecification: Filters by publication year range [yearFrom, yearTo].
 */
export class YearRangeSpecification extends CompositeSpecification {
  constructor(
    public readonly yearFrom?: number,
    public readonly yearTo?: number,
  ) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    const yearFilter: Record<string, unknown> = {};
    if (this.yearFrom !== undefined && this.yearFrom !== null) {
      yearFilter.gte = Number(this.yearFrom);
    }
    if (this.yearTo !== undefined && this.yearTo !== null) {
      yearFilter.lte = Number(this.yearTo);
    }
    return { year: yearFilter };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const year = typeof rec.year === 'number' ? rec.year : undefined;
    if (
      this.yearFrom !== undefined &&
      this.yearFrom !== null &&
      (year === undefined || year < Number(this.yearFrom))
    )
      return false;
    if (
      this.yearTo !== undefined &&
      this.yearTo !== null &&
      (year === undefined || year > Number(this.yearTo))
    )
      return false;
    return true;
  }
}

/**
 * CollectionSpecification: Filters by collection membership.
 */
export class CollectionSpecification extends CompositeSpecification {
  private readonly collectionIds: string[];

  constructor(public readonly collectionId: string | string[]) {
    super();
    this.collectionIds = Array.isArray(collectionId)
      ? collectionId
      : [collectionId];
  }

  toPrismaWhere(): QueryCriteria {
    if (this.collectionIds.length === 1) {
      return {
        collectionItems: {
          some: {
            collectionId: this.collectionIds[0],
            collection: { deletedAt: null },
          },
        },
      };
    }
    return {
      collectionItems: {
        some: {
          collectionId: { in: this.collectionIds },
          collection: { deletedAt: null },
        },
      },
    };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const list = Array.isArray(rec.collectionItems)
      ? (rec.collectionItems as Array<{
          collectionId?: string;
          collection?: { deletedAt?: unknown } | null;
        } | null>)
      : [];
    return list.some(
      (c) =>
        c?.collectionId != null &&
        !c.collection?.deletedAt &&
        this.collectionIds.includes(c.collectionId),
    );
  }
}

/**
 * TagSpecification: Filters by tag membership.
 */
export class TagSpecification extends CompositeSpecification {
  constructor(public readonly tagId: string) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    return {
      itemTags: {
        some: { tagId: this.tagId },
      },
    };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const list = Array.isArray(rec.itemTags)
      ? (rec.itemTags as Array<{ tagId?: string } | null>)
      : [];
    return list.some((t) => t?.tagId === this.tagId);
  }
}

/**
 * TagNamesSpecification: Filters by one or more tag names (case-insensitive).
 */
export class TagNamesSpecification extends CompositeSpecification {
  private readonly tagNames: string[];

  constructor(tagNamesInput: string | string[]) {
    super();
    const rawList = Array.isArray(tagNamesInput)
      ? tagNamesInput
      : [tagNamesInput];
    this.tagNames = rawList
      .flatMap((t) => String(t).split(','))
      .map((t) => t.trim())
      .filter(Boolean);
  }

  toPrismaWhere(): QueryCriteria {
    if (this.tagNames.length === 0) return {};
    return {
      itemTags: {
        some: {
          tag: {
            OR: this.tagNames.map((name) => ({
              name: { equals: name, mode: 'insensitive' as const },
            })),
          },
        },
      },
    };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (this.tagNames.length === 0) return true;
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const lowerSet = new Set(this.tagNames.map((n) => n.toLowerCase()));
    const list = Array.isArray(rec.itemTags)
      ? (rec.itemTags as Array<{ tag?: { name?: string } | null } | null>)
      : [];
    return list.some(
      (t) =>
        typeof t?.tag?.name === 'string' &&
        lowerSet.has(t.tag.name.toLowerCase()),
    );
  }
}

/**
 * CustomCriteriaSpecification: Wraps arbitrary Prisma WHERE criteria into a composable specification.
 */
export class CustomCriteriaSpecification extends CompositeSpecification {
  constructor(
    private readonly criteria: QueryCriteria,
    private readonly predicate?: (item: Record<string, unknown>) => boolean,
  ) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    return this.criteria;
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!this.predicate) return true;
    if (!item || typeof item !== 'object') return false;
    return this.predicate(item as Record<string, unknown>);
  }
}

interface ItemDenormalizedCountClient {
  attachment?: {
    count?: (args: { where: { itemId: string; deletedAt: null } }) => Promise<number>;
  };
  libraryNote?: {
    count?: (args: { where: { itemId: string; deletedAt: null } }) => Promise<number>;
  };
  note?: {
    count?: (args: { where: { itemId: string; deletedAt: null } }) => Promise<number>;
  };
  libraryItem?: {
    updateMany?: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    update?: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
  item?: {
    updateMany?: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    update?: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

const SPEC_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared repository helper to recount and synchronize denormalized `attachmentCount`,
 * `hasFile`, and `noteCount` columns on `LibraryItem` within a Prisma client or transaction.
 */
export async function syncItemDenormalizedCountsInClient(
  db: ItemDenormalizedCountClient | null | undefined,
  itemId: string | null | undefined,
  options?: { attachments?: boolean; notes?: boolean; requireUuid?: boolean },
): Promise<void> {
  const itemClient = db?.libraryItem ?? db?.item;
  if (!itemId || !itemClient) return;
  if (options?.requireUuid && !SPEC_UUID_REGEX.test(itemId)) return;

  const syncAttachments = options?.attachments ?? false;
  const syncNotes = options?.notes ?? false;
  if (!syncAttachments && !syncNotes) return;

  const data: Record<string, unknown> = {};
  const noteClient = db?.libraryNote ?? db?.note;

  const [rawAttachmentCount, activeNoteCount] = await Promise.all([
    syncAttachments && db?.attachment
      ? db.attachment.count
        ? db.attachment.count({ where: { itemId, deletedAt: null } })
        : 1
      : undefined,
    syncNotes && noteClient?.count
      ? noteClient.count({ where: { itemId, deletedAt: null } })
      : undefined,
  ]);

  if (rawAttachmentCount !== undefined) {
    const activeCount = Math.max(0, rawAttachmentCount);
    data.hasFile = activeCount > 0;
    data.attachmentCount = activeCount;
  }
  if (activeNoteCount !== undefined) {
    data.noteCount = Math.max(0, activeNoteCount);
  }

  if (Object.keys(data).length === 0) return;

  if (itemClient.updateMany) {
    await itemClient.updateMany({ where: { id: itemId }, data });
  } else if (itemClient.update) {
    await itemClient.update({ where: { id: itemId }, data });
  }
}

/**
 * Executes a Unit of Work transaction and guarantees that `afterCommit` runs once:
 * via `helpers.onAfterCommit` if supported by the transaction runner, or immediately
 * after `executeInTransaction` resolves when `onAfterCommit` is absent (e.g., in test mocks).
 */
export async function executeWithPostCommit<T>(
  uow: IUnitOfWork,
  work: (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => Promise<T>,
  afterCommit: (result: T) => Promise<void> | void,
): Promise<T> {
  let registered = false;
  let capturedResult!: T;
  const result = await uow.executeInTransaction(async (tx, helpers) => {
    const res = await work(tx, helpers);
    capturedResult = res;
    if (helpers?.onAfterCommit) {
      registered = true;
      helpers.onAfterCommit(() => afterCommit(res));
    }
    return res;
  });
  if (!registered) {
    await afterCommit(result ?? capturedResult);
  }
  return result;
}

/**
 * Automatically disambiguates citation keys against existing items in the project or user scope.
 * Follows BibTeX / BetterBibTeX convention: vaswani2017attention -> vaswani2017attentiona -> vaswani2017attentionb.
 */
export async function disambiguateCitationKey(
  db: Prisma.TransactionClient | { libraryItem?: { findMany?: Prisma.TransactionClient['libraryItem']['findMany'] }; item?: { findMany?: Prisma.TransactionClient['libraryItem']['findMany'] } } | null | undefined,
  baseKey: string | null | undefined,
  scope: { userId: string; projectId?: string | null },
  excludeItemId?: string,
): Promise<string | null> {
  if (!baseKey || !baseKey.trim()) return null;
  const cleanKey = baseKey.trim();
  const itemDelegate = (db as { libraryItem?: { findMany?: Prisma.TransactionClient['libraryItem']['findMany'] }; item?: { findMany?: Prisma.TransactionClient['libraryItem']['findMany'] } } | null | undefined)?.libraryItem ?? (db as { item?: { findMany?: Prisma.TransactionClient['libraryItem']['findMany'] } } | null | undefined)?.item;
  if (typeof itemDelegate?.findMany !== 'function') return cleanKey;
  const scopeWhere: Prisma.LibraryItemWhereInput = {
    spaceId: resolveSpaceId(scope),
  };
  const rows = await itemDelegate.findMany({
    where: {
      ...scopeWhere,
      deletedAt: null,
      ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
      citationKey: { startsWith: cleanKey, mode: 'insensitive' },
    },
    select: { citationKey: true },
    take: 500,
  });
  const existingKeys = new Set(
    (Array.isArray(rows) ? rows : [])
      .map((item: { citationKey?: string | null }) => item.citationKey?.toLowerCase())
      .filter((k: string | undefined): k is string => Boolean(k)),
  );
  if (!existingKeys.has(cleanKey.toLowerCase())) return cleanKey;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < alphabet.length; i++) {
    const candidate = `${cleanKey}${alphabet[i]}`;
    if (!existingKeys.has(candidate.toLowerCase())) return candidate;
  }
  let counter = 1;
  while (existingKeys.has(`${cleanKey}-${counter}`.toLowerCase())) counter++;
  return `${cleanKey}-${counter}`;
}
