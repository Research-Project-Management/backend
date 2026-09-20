import { ItemAggregate } from '../../domain/model/item.aggregate';

export interface ItemResultDto {
  id: string;
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
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
  tags?: string[];
  attachments?: any[];
  contributors?: any[];
  collections?: any[];
}

export function toItemResultDto(aggregate: ItemAggregate): ItemResultDto {
  return {
    id: aggregate.id,
    userId: aggregate.userId,
    projectId: aggregate.projectId,
    title: aggregate.title,
    itemType: aggregate.itemType,
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
  };
}
