import { Prisma } from '@prisma/client';
import { CompositeSpecification } from './specification.interface';

export { CompositeSpecification };

/**
 * ScopeSpecification: Enforces multi-tenant isolation.
 * Resolves to projectId for collaborative workspaces, or userId for personal library.
 */
export class ScopeSpecification extends CompositeSpecification {
  constructor(
    public readonly userId: string,
    public readonly projectId?: string,
  ) {
    super();
  }

  isSatisfiedBy(candidate: any): boolean {
    if (
      this.projectId &&
      this.projectId !== 'user' &&
      this.projectId !== 'me' &&
      this.projectId !== 'personal'
    ) {
      return candidate?.projectId === this.projectId;
    }
    return candidate?.userId === this.userId;
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    if (
      this.projectId &&
      this.projectId !== 'user' &&
      this.projectId !== 'me' &&
      this.projectId !== 'personal'
    ) {
      return { projectId: this.projectId };
    }
    return { userId: this.userId };
  }
}

/**
 * ActiveItemsSpecification: Filters out soft-deleted items.
 */
export class ActiveItemsSpecification extends CompositeSpecification {
  isSatisfiedBy(candidate: any): boolean {
    return candidate?.deletedAt == null;
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    return { deletedAt: null };
  }
}

/**
 * ItemTypeSpecification: Filters by bibliographic item type (journalArticle, book, etc.).
 */
export class ItemTypeSpecification extends CompositeSpecification {
  private readonly itemTypes: string[];

  constructor(itemTypes: string | string[]) {
    super();
    this.itemTypes = Array.isArray(itemTypes) ? itemTypes : [itemTypes];
  }

  isSatisfiedBy(candidate: any): boolean {
    return this.itemTypes.includes(candidate?.itemType);
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    if (this.itemTypes.length === 1) {
      return { itemType: this.itemTypes[0] };
    }
    return { itemType: { in: this.itemTypes } };
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

  isSatisfiedBy(candidate: any): boolean {
    if (candidate?.year == null) return false;
    const y = Number(candidate.year);
    if (this.yearFrom !== undefined && y < this.yearFrom) return false;
    if (this.yearTo !== undefined && y > this.yearTo) return false;
    return true;
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    const yearFilter: Prisma.IntNullableFilter = {};
    if (this.yearFrom !== undefined) yearFilter.gte = this.yearFrom;
    if (this.yearTo !== undefined) yearFilter.lte = this.yearTo;
    return { year: yearFilter };
  }
}

/**
 * CollectionSpecification: Filters by collection membership.
 */
export class CollectionSpecification extends CompositeSpecification {
  constructor(public readonly collectionId: string) {
    super();
  }

  isSatisfiedBy(candidate: any): boolean {
    if (candidate?.collectionId === this.collectionId) return true;
    if (Array.isArray(candidate?.collectionItems)) {
      return candidate.collectionItems.some(
        (ci: any) => ci?.collectionId === this.collectionId || ci?.collection?.id === this.collectionId,
      );
    }
    return false;
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    return {
      collectionItems: {
        some: { collectionId: this.collectionId },
      },
    };
  }
}

/**
 * TagSpecification: Filters by tag membership.
 */
export class TagSpecification extends CompositeSpecification {
  constructor(public readonly tagId: string) {
    super();
  }

  isSatisfiedBy(candidate: any): boolean {
    if (Array.isArray(candidate?.itemTags)) {
      return candidate.itemTags.some(
        (it: any) => it?.tagId === this.tagId || it?.tag?.id === this.tagId,
      );
    }
    return false;
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    return {
      itemTags: {
        some: { tagId: this.tagId },
      },
    };
  }
}

/**
 * TextSearchSpecification: Comprehensive search across bibliographic metadata,
 * contributors, literature notes, and PDF annotations.
 */
export class TextSearchSpecification extends CompositeSpecification {
  public readonly query: string;

  constructor(query: string) {
    super();
    this.query = (query ?? '').trim();
  }

  isSatisfiedBy(candidate: any): boolean {
    if (!this.query) return true;
    const qLower = this.query.toLowerCase();

    // 1. Bibliographic fields
    if (candidate?.title?.toLowerCase().includes(qLower)) return true;
    if (candidate?.abstract?.toLowerCase().includes(qLower)) return true;
    if (candidate?.doi?.toLowerCase().includes(qLower)) return true;
    if (candidate?.citationKey?.toLowerCase().includes(qLower)) return true;

    // 2. Contributors
    if (Array.isArray(candidate?.contributors)) {
      const match = candidate.contributors.some(
        (c: any) =>
          c?.fullName?.toLowerCase().includes(qLower) ||
          c?.lastName?.toLowerCase().includes(qLower),
      );
      if (match) return true;
    }

    // 3. Notes
    if (Array.isArray(candidate?.notesList)) {
      const match = candidate.notesList.some(
        (n: any) =>
          n?.deletedAt == null &&
          (n?.title?.toLowerCase().includes(qLower) ||
            n?.contentMd?.toLowerCase().includes(qLower)),
      );
      if (match) return true;
    }

    // 4. Annotations
    if (Array.isArray(candidate?.attachments)) {
      const match = candidate.attachments.some(
        (att: any) =>
          att?.deletedAt == null &&
          Array.isArray(att?.annotations) &&
          att.annotations.some(
            (ann: any) =>
              ann?.deletedAt == null &&
              (ann?.quoteText?.toLowerCase().includes(qLower) ||
                ann?.comment?.toLowerCase().includes(qLower)),
          ),
      );
      if (match) return true;
    }

    return false;
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    if (!this.query) return {};

    return {
      OR: [
        { title: { contains: this.query, mode: 'insensitive' } },
        { abstract: { contains: this.query, mode: 'insensitive' } },
        { doi: { contains: this.query, mode: 'insensitive' } },
        { citationKey: { contains: this.query, mode: 'insensitive' } },
        {
          contributors: {
            some: {
              OR: [
                { fullName: { contains: this.query, mode: 'insensitive' } },
                { lastName: { contains: this.query, mode: 'insensitive' } },
              ],
            },
          },
        },
        {
          notesList: {
            some: {
              deletedAt: null,
              OR: [
                { title: { contains: this.query, mode: 'insensitive' } },
                { contentMd: { contains: this.query, mode: 'insensitive' } },
              ],
            },
          },
        },
        {
          attachments: {
            some: {
              deletedAt: null,
              annotations: {
                some: {
                  deletedAt: null,
                  OR: [
                    { quoteText: { contains: this.query, mode: 'insensitive' } },
                    { comment: { contains: this.query, mode: 'insensitive' } },
                  ],
                },
              },
            },
          },
        },
      ],
    };
  }
}
