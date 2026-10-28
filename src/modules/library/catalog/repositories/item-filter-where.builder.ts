import { Prisma, ReadStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import {
  normalizeProjectScopeId,
  AcademicSearchQueryEngine,
  ScopeSpecification,
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
} from '@/modules/library/core';

export {
  ScopeSpecification,
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
};

export const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

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
  const trimmed = search.trim();
  const numericYear = /^\d{4}$/.test(trimmed) ? Number(trimmed) : null;

  const creatorClause: Prisma.ItemWhereInput = {
    contributors: {
      some: {
        OR: [
          { fullName: { contains: trimmed, mode: 'insensitive' } },
          { lastName: { contains: trimmed, mode: 'insensitive' } },
          { firstName: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
    },
  };

  if (searchMode === 'title_creator_year') {
    const clauses: Prisma.ItemWhereInput[] = [
      { title: { contains: trimmed, mode: 'insensitive' } },
      creatorClause,
    ];
    if (numericYear !== null) {
      clauses.push({ year: numericYear });
    }
    return clauses;
  }

  const extractedIds = AcademicSearchQueryEngine.extractIdentifiers(trimmed);
  const normalizedIsbnCandidate = extractedIds.cleanIsbn;
  const normalizedArxivCandidate =
    extractedIds.cleanArxivBase || extractedIds.cleanArxiv;
  const normalizedPmidCandidate = extractedIds.cleanPmid;
  const normalizedPmcidCandidate = extractedIds.cleanPmcid;
  const normalizedDoiCandidate = extractedIds.cleanDoi;
  const normalizedIssnCandidate = extractedIds.cleanIssn;

  const relationalIdentTerms = Array.from(
    new Set(
      [
        trimmed,
        normalizedDoiCandidate,
        normalizedIsbnCandidate,
        normalizedIssnCandidate,
        normalizedArxivCandidate,
        normalizedPmidCandidate,
        normalizedPmcidCandidate,
      ].filter((v): v is string => Boolean(v && v.trim())),
    ),
  );

  const baseClauses: Prisma.ItemWhereInput[] = [
    { title: { contains: trimmed, mode: 'insensitive' } },
    { publicationTitle: { contains: trimmed, mode: 'insensitive' } },
    { abstract: { contains: trimmed, mode: 'insensitive' } },
    {
      doi: {
        contains: normalizedDoiCandidate || trimmed,
        mode: 'insensitive',
      },
    },
    { citationKey: { contains: trimmed, mode: 'insensitive' } },
    ...(numericYear !== null ? [{ year: numericYear }] : []),
    ...relationalIdentTerms.map((term) => ({
      identifiers: {
        some: { value: { contains: term, mode: 'insensitive' as const } },
      },
    })),
    {
      metadata: {
        path: ['isbn'],
        string_contains: normalizedIsbnCandidate || trimmed,
      },
    },
    ...(normalizedIsbnCandidate && normalizedIsbnCandidate !== trimmed
      ? [
          {
            metadata: {
              path: ['isbn'],
              string_contains: trimmed,
            },
          },
        ]
      : []),
    {
      metadata: {
        path: ['issn'],
        string_contains: normalizedIssnCandidate || trimmed,
      },
    },
    {
      metadata: {
        path: ['pmid'],
        string_contains: normalizedPmidCandidate || trimmed,
      },
    },
    ...(normalizedPmcidCandidate
      ? [
          {
            metadata: {
              path: ['pmcid'],
              string_contains: normalizedPmcidCandidate,
            },
          },
        ]
      : [
          {
            metadata: {
              path: ['pmcid'],
              string_contains: trimmed,
            },
          },
        ]),
    {
      metadata: {
        path: ['arxivId'],
        string_contains: normalizedArxivCandidate || trimmed,
      },
    },
    {
      metadata: {
        path: ['publisher'],
        string_contains: trimmed,
      },
    },
    creatorClause,
    {
      itemTags: {
        some: {
          tag: {
            name: { contains: trimmed, mode: 'insensitive' },
          },
        },
      },
    },
  ];

  if (searchMode === 'fields_tags') {
    return baseClauses;
  }

  if (searchMode === 'everything') {
    return [
      ...baseClauses,
      {
        notesList: {
          some: {
            deletedAt: null,
            OR: [
              { title: { contains: trimmed, mode: 'insensitive' } },
              { contentMd: { contains: trimmed, mode: 'insensitive' } },
            ],
          },
        },
      },
      {
        attachments: {
          some: {
            deletedAt: null,
            OR: [
              { filename: { contains: trimmed, mode: 'insensitive' } },
              {
                fullTextIndexes: {
                  some: {
                    textContent: { contains: trimmed, mode: 'insensitive' },
                  },
                },
              },
            ],
          },
        },
      },
    ];
  }

  // Default backward-compatible bibliographic + contributor search
  return baseClauses.slice(0, -1);
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
    >((acc, spec) => acc.and(spec) as CompositeSpecification<Record<string, unknown>, Prisma.ItemWhereInput>, specs[0])
    .toPrismaWhere();
  if (combined && Array.isArray(combined.AND)) {
    return combined.AND as Prisma.ItemWhereInput[];
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

  if (view === 'trash') {
    where.deletedAt = { not: null };
  } else {
    where.deletedAt = null;
    if (view === 'unfiled') {
      where.collectionItems = { none: {} };
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
          metadata: { path: ['isRetracted'], equals: true },
        }),
      );
    }
  }

  if (options.isRetracted !== undefined && view !== 'retracted') {
    if (options.isRetracted) {
      andSpecs.push(
        new ItemWhereSpecification({
          metadata: { path: ['isRetracted'], equals: true },
        }),
      );
    } else {
      andSpecs.push(
        new ItemWhereSpecification({
          NOT: { metadata: { path: ['isRetracted'], equals: true } },
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
    if (targetCollectionIds.length === 1) {
      where.collectionItems = {
        some: { collectionId: targetCollectionIds[0] },
      };
    } else {
      where.collectionItems = {
        some: { collectionId: { in: targetCollectionIds } },
      };
    }
  } else if (options.collectionId) {
    where.collectionItems = { some: { collectionId: options.collectionId } };
  }

  if (options.tagId) {
    tagSpecs.push(
      new ItemWhereSpecification({
        itemTags: { some: { tagId: options.tagId } },
      }),
    );
  }

  if (options.tag) {
    const tagNames = options.tag
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tagNames.length > 0) {
      tagSpecs.push(
        new ItemWhereSpecification({
          itemTags: {
            some: {
              tag: {
                OR: tagNames.map((name) => ({
                  name: { equals: name, mode: 'insensitive' as const },
                })),
              },
            },
          },
        }),
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
    if (itemType.includes(',')) {
      const types = itemType
        .split(',')
        .map((t: string) => t.trim())
        .filter(Boolean);
      where.itemType = { in: types };
    } else {
      where.itemType = itemType;
    }
  }

  if (options.fromYear !== undefined || options.toYear !== undefined) {
    where.year = {
      ...(options.fromYear !== undefined
        ? { gte: Number(options.fromYear) }
        : {}),
      ...(options.toYear !== undefined ? { lte: Number(options.toYear) } : {}),
    };
  }

  if (options.readStatus && options.readStatus !== 'all') {
    const validStatuses: ReadStatus[] = ['unread', 'reading', 'completed'];
    const statuses = options.readStatus
      .split(',')
      .map((s) => (s.trim() === 'read' ? 'completed' : s.trim()))
      .filter((s): s is ReadStatus => validStatuses.includes(s as ReadStatus));
    if (statuses.length > 0) {
      if (statuses.length === 1 && statuses[0] === 'unread') {
        andSpecs.push(
          new ItemWhereSpecification({
            OR: [
              { states: { none: { userId } } },
              { states: { some: { userId, readStatus: 'unread' } } },
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
