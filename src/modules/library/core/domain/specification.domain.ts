import { isUuid } from '@/core';

export type QueryCriteria = Record<string, unknown>;

/**
 * GoF / DDD Specification Pattern Interface.
 *
 * Encapsulates domain query and filtering criteria into reusable, composable objects.
 * Supports:
 * - In-memory predicate evaluation via `isSatisfiedBy(item)`
 * - Database query compilation via `toPrismaWhere()`
 * - Logical composition via `.and()`, `.or()`, and `.not()`
 */
export interface ISpecification<T = unknown, TWhere = QueryCriteria> {
  toPrismaWhere(): TWhere;
  isSatisfiedBy(item: T): boolean;
  and(other: ISpecification<T, TWhere>): ISpecification<T, TWhere>;
  or(other: ISpecification<T, TWhere>): ISpecification<T, TWhere>;
  not(): ISpecification<T, TWhere>;
}

export abstract class CompositeSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> implements ISpecification<T, TWhere> {
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
  return (
    !where ||
    (typeof where === 'object' &&
      !Array.isArray(where) &&
      Object.keys(where).length === 0)
  );
}

function extractCombinatorClauses(
  where: unknown,
  operator: 'AND' | 'OR',
): unknown[] {
  if (where && typeof where === 'object' && !Array.isArray(where)) {
    const rec = where as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (
      keys.length === 1 &&
      keys[0] === operator &&
      Array.isArray(rec[operator])
    ) {
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
const PERSONAL_SCOPE_ALIASES = new Set([
  'user',
  'me',
  'personal',
  'none',
  'undefined',
  'null',
]);

/**
 * Type guard that checks whether a candidate projectId represents a valid
 * collaborative project scope (as opposed to personal library aliases like
 * 'user', 'me', 'personal', 'none', or empty values).
 */
export function isProjectScopeId(
  projectId?: string | null,
): projectId is string {
  if (!projectId || typeof projectId !== 'string') {
    return false;
  }
  const trimmed = projectId.trim();
  return (
    trimmed.length > 0 && !PERSONAL_SCOPE_ALIASES.has(trimmed.toLowerCase())
  );
}

/**
 * Normalizes a candidate projectId into a valid project UUID/identifier string
 * or `undefined` if it is empty or a personal library alias ('user', 'me', 'personal', 'none').
 */
export function normalizeProjectScopeId(
  projectId?: string | null,
): string | undefined {
  return isProjectScopeId(projectId) ? projectId.trim() : undefined;
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
    if (isProjectScopeId(this.projectId)) {
      return { projectId: this.projectId.trim() };
    }
    return { userId: this.userId, projectId: null };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
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
