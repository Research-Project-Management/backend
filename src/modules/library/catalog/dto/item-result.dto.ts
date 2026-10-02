import { ItemAggregate } from '../core/domain/item.aggregate';

export interface ItemResultDto {
  id: string;
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
  type?: string;
  doi?: string | null;
  citationKey?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  version: number;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  fields?: Record<string, any>;
  authors?: string[];
  creators?: any[];
  contributors?: any[];
  tags?: string[];
  labels?: string[];
  keywords?: string[];
  attachments?: any[];
  primaryFile?: any;
  fileUrl?: string;
  collections?: any[];
  collectionIds?: string[];
  collectionId?: string | null;
  notes?: any[];
  isStarred?: boolean;
  hasFile?: boolean;
  attachmentCount?: number;
  noteCount?: number;
  firstAuthor?: string | null;
  readStatus?: string;
  rating?: number;
  lastReadAt?: string | null;
  identifiers?: any[];
  isMyPublication?: boolean;
  relations?: any[];
  seeAlso?: string[];
  /**
   * Zotero-compatible meta envelope.
   * creatorSummary: "Smith et al." / "Smith and Jones" / "Smith"
   * parsedDate: ISO date string parsed from the raw date field (e.g. "1948-07-01")
   * numChildren: total child items (notes + attachments)
   */
  meta?: {
    creatorSummary?: string;
    parsedDate?: string;
    numChildren?: number;
  };
  [key: string]: any;
}

export function toItemResultDto(aggregate: ItemAggregate): ItemResultDto {
  const fields = aggregate.fields ?? {};
  return {
    ...fields,
    id: aggregate.id,
    userId: aggregate.userId,
    projectId: aggregate.projectId,
    title: aggregate.title,
    itemType: aggregate.itemType,
    type: aggregate.itemType,
    doi: aggregate.doi,
    citationKey: aggregate.citationKey,
    abstract: aggregate.abstract,
    year: aggregate.year,
    publicationTitle: aggregate.publicationTitle,
    version: aggregate.version,
    isDeleted: aggregate.isDeleted,
    createdAt: aggregate.createdAt,
    updatedAt: aggregate.updatedAt,
    fields: aggregate.fields,
    // Explicitly guarantee essential frontend arrays and state fields
    authors:
      aggregate.authors.length > 0 ? aggregate.authors : (fields.authors ?? []),
    creators:
      aggregate.creators.length > 0
        ? aggregate.creators
        : (fields.creators ?? []),
    contributors:
      aggregate.contributors.length > 0
        ? aggregate.contributors
        : (fields.contributors ?? []),
    tags: aggregate.tags.length > 0 ? aggregate.tags : (fields.tags ?? []),
    labels:
      fields.labels ??
      (aggregate.tags.length > 0 ? aggregate.tags : (fields.tags ?? [])),
    keywords:
      fields.keywords ??
      (aggregate.tags.length > 0 ? aggregate.tags : (fields.tags ?? [])),
    attachments:
      aggregate.attachments.length > 0
        ? aggregate.attachments
        : (fields.attachments ?? []),
    primaryFile: aggregate.primaryFile ?? fields.primaryFile ?? null,
    fileUrl: aggregate.fileUrl || fields.fileUrl || '',
    collections:
      aggregate.collections.length > 0
        ? aggregate.collections
        : (fields.collections ?? []),
    collectionIds:
      aggregate.collectionIds.length > 0
        ? aggregate.collectionIds
        : (fields.collectionIds ?? []),
    collectionId: aggregate.collectionId ?? fields.collectionId ?? null,
    notes: aggregate.notes.length > 0 ? aggregate.notes : (fields.notes ?? []),
    isStarred: aggregate.isStarred || Boolean(fields.isStarred),
    hasFile: aggregate.hasFile || Boolean(fields.hasFile),
    attachmentCount: aggregate.attachmentCount ?? fields.attachmentCount ?? 0,
    noteCount: aggregate.noteCount ?? fields.noteCount ?? 0,
    firstAuthor: aggregate.firstAuthor ?? fields.firstAuthor ?? null,
    readStatus:
      aggregate.readStatus !== 'unread'
        ? aggregate.readStatus
        : (fields.readStatus ?? 'unread'),
    rating: aggregate.rating !== 0 ? aggregate.rating : (fields.rating ?? 0),
    lastReadAt: aggregate.lastReadAt ?? fields.lastReadAt ?? null,
    identifiers:
      aggregate.identifiers.length > 0
        ? aggregate.identifiers
        : (fields.identifiers ?? []),
    isMyPublication:
      (aggregate as any).isMyPublication !== undefined
        ? Boolean((aggregate as any).isMyPublication)
        : Boolean(fields.isMyPublication),
    relations: (aggregate as any).relations ?? fields.relations ?? [],
    seeAlso: (aggregate as any).seeAlso ?? fields.seeAlso ?? [],
    // Zotero-compatible meta envelope
    meta: buildMetaEnvelope(aggregate, fields),
  };
}

/**
 * Builds the Zotero-compatible meta envelope:
 * - creatorSummary: "Smith et al." / "Smith and Jones" / "Smith"
 * - parsedDate: ISO date parsed from year or publicationDate
 * - numChildren: total child items (notes + attachments)
 */
function buildMetaEnvelope(
  aggregate: ItemAggregate,
  fields: Record<string, any>,
): { creatorSummary?: string; parsedDate?: string; numChildren?: number } {
  // creatorSummary — first author's last name + "et al." if multiple
  const authors =
    aggregate.authors.length > 0 ? aggregate.authors : (fields.authors ?? []);
  const creators =
    aggregate.creators.length > 0
      ? aggregate.creators
      : (fields.creators ?? []);

  let creatorSummary: string | undefined;
  // Try to extract last name from creators first (structured), fall back to authors (string array)
  const primaryCreators = (creators as any[]).filter(
    (c) => !c.creatorType || c.creatorType === 'author',
  );
  if (primaryCreators.length > 0) {
    const first = primaryCreators[0];
    const lastName =
      first.lastName ||
      (typeof first.fullName === 'string'
        ? first.fullName.split(/[\s,]+/).pop()
        : undefined) ||
      (typeof first.name === 'string' ? first.name : undefined);
    if (lastName) {
      creatorSummary =
        primaryCreators.length === 1
          ? lastName
          : primaryCreators.length === 2
            ? (() => {
                const second = primaryCreators[1];
                const secondLast =
                  second.lastName ||
                  (typeof second.fullName === 'string'
                    ? second.fullName.split(/[\s,]+/).pop()
                    : undefined);
                return secondLast ? `${lastName} and ${secondLast}` : lastName;
              })()
            : `${lastName} et al.`;
    }
  } else if ((authors as string[]).length > 0) {
    // Fall back to raw author strings
    const firstAuthorStr = String(authors[0]);
    const lastName = firstAuthorStr.includes(',')
      ? firstAuthorStr.split(',')[0].trim()
      : firstAuthorStr.split(/\s+/).pop() || firstAuthorStr;
    creatorSummary =
      (authors as string[]).length === 1
        ? lastName
        : (authors as string[]).length === 2
          ? (() => {
              const second = String((authors as string[])[1]);
              const secondLast = second.includes(',')
                ? second.split(',')[0].trim()
                : second.split(/\s+/).pop() || second;
              return `${lastName} and ${secondLast}`;
            })()
          : `${lastName} et al.`;
  }

  // parsedDate — ISO date from publicationDate or year
  let parsedDate: string | undefined;
  const rawPubDate = fields.publicationDate ?? fields.date;
  const rawYear = aggregate.year ?? fields.year;
  if (rawPubDate && typeof rawPubDate === 'string') {
    // Already ISO format (YYYY-MM-DD or YYYY-MM) — use directly
    parsedDate = rawPubDate;
  } else if (rawYear && !isNaN(Number(rawYear))) {
    parsedDate = String(Number(rawYear)).padStart(4, '0');
  }

  // numChildren = notes + attachments
  const numChildren =
    (aggregate.noteCount ?? fields.noteCount ?? 0) +
    (aggregate.attachmentCount ?? fields.attachmentCount ?? 0);

  return {
    ...(creatorSummary ? { creatorSummary } : {}),
    ...(parsedDate ? { parsedDate } : {}),
    numChildren,
  };
}
