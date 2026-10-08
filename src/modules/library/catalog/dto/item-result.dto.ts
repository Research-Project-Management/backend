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
      fields.isMyPublication !== undefined
        ? Boolean(fields.isMyPublication)
        : Boolean(aggregate.fields?.isMyPublication),
    relations: fields.relations ?? aggregate.fields?.relations ?? [],
    seeAlso: fields.seeAlso ?? aggregate.fields?.seeAlso ?? [],
    meta: buildMetaEnvelope(aggregate, fields),
  };
}

function buildMetaEnvelope(
  aggregate: ItemAggregate,
  fields: Record<string, any>,
): { creatorSummary?: string; parsedDate?: string; numChildren?: number } {
  const authors =
    aggregate.authors.length > 0 ? aggregate.authors : (fields.authors ?? []);
  const creators =
    aggregate.creators.length > 0
      ? aggregate.creators
      : (fields.creators ?? []);

  let creatorSummary: string | undefined;
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

  let parsedDate: string | undefined;
  const rawPubDate = fields.publicationDate ?? fields.date;
  const rawYear = aggregate.year ?? fields.year;
  if (rawPubDate && typeof rawPubDate === 'string') {
    parsedDate = rawPubDate;
  } else if (rawYear && !isNaN(Number(rawYear))) {
    parsedDate = String(Number(rawYear)).padStart(4, '0');
  }

  const numChildren =
    (aggregate.noteCount ?? fields.noteCount ?? 0) +
    (aggregate.attachmentCount ?? fields.attachmentCount ?? 0);

  return {
    ...(creatorSummary ? { creatorSummary } : {}),
    ...(parsedDate ? { parsedDate } : {}),
    numChildren,
  };
}
