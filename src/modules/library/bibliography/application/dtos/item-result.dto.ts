import { ItemAggregate } from '../../domain/model/item.aggregate';

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
  readStatus?: string;
  rating?: number;
  lastReadAt?: string | null;
  identifiers?: any[];
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
      aggregate.authors.length > 0
        ? aggregate.authors
        : fields.authors ?? [],
    creators:
      aggregate.creators.length > 0
        ? aggregate.creators
        : fields.creators ?? [],
    contributors:
      aggregate.contributors.length > 0
        ? aggregate.contributors
        : fields.contributors ?? [],
    tags:
      aggregate.tags.length > 0
        ? aggregate.tags
        : fields.tags ?? [],
    labels:
      fields.labels ??
      (aggregate.tags.length > 0 ? aggregate.tags : fields.tags ?? []),
    keywords:
      fields.keywords ??
      (aggregate.tags.length > 0 ? aggregate.tags : fields.tags ?? []),
    attachments:
      aggregate.attachments.length > 0
        ? aggregate.attachments
        : fields.attachments ?? [],
    primaryFile: aggregate.primaryFile ?? fields.primaryFile ?? null,
    fileUrl: aggregate.fileUrl || fields.fileUrl || '',
    collections:
      aggregate.collections.length > 0
        ? aggregate.collections
        : fields.collections ?? [],
    collectionIds:
      aggregate.collectionIds.length > 0
        ? aggregate.collectionIds
        : fields.collectionIds ?? [],
    collectionId: aggregate.collectionId ?? fields.collectionId ?? null,
    notes:
      aggregate.notes.length > 0
        ? aggregate.notes
        : fields.notes ?? [],
    readStatus:
      aggregate.readStatus !== 'unread'
        ? aggregate.readStatus
        : fields.readStatus ?? 'unread',
    rating:
      aggregate.rating !== 0 ? aggregate.rating : fields.rating ?? 0,
    lastReadAt: aggregate.lastReadAt ?? fields.lastReadAt ?? null,
    identifiers:
      aggregate.identifiers.length > 0
        ? aggregate.identifiers
        : fields.identifiers ?? [],
  };
}
