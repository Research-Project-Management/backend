import {
  IsString,
  IsUUID,
  IsArray,
  ArrayNotEmpty,
  IsOptional,
  IsObject,
} from 'class-validator';

export const ALLOWED_MERGE_METADATA_FIELDS = new Set([
  'title',
  'authors',
  'creators',
  'year',
  'doi',
  'abstract',
  'abstractNote',
  'itemType',
  'editors',
  'journal',
  'publicationTitle',
  'publicationDate',
  'publisher',
  'place',
  'volume',
  'issue',
  'section',
  'partNumber',
  'partTitle',
  'pages',
  'series',
  'seriesTitle',
  'seriesText',
  'issn',
  'isbn',
  'pmid',
  'pmcid',
  'url',
  'type',
  'language',
  'journalAbbr',
  'shortTitle',
  'rights',
  'license',
  'citationKey',
  'libraryCatalog',
  'archive',
  'archiveLocation',
  'callNumber',
  'extra',
]);

export class MergeDuplicatesDto {
  @IsUUID('4', { message: 'primaryItemId must be a valid UUID v4' })
  primaryItemId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'duplicateItemIds must contain at least one ID' })
  @IsUUID('4', {
    each: true,
    message: 'Each duplicateItemId must be a valid UUID v4',
  })
  duplicateItemIds!: string[];

  @IsOptional()
  @IsObject()
  fieldSelections?: Record<string, any>;
}

export interface DuplicateClusterItem {
  id: string;
  title: string;
  doi?: string;
  year?: number | null;
  authors?: string[];
  citationKey?: string;
  collectionId?: string | null;
}

export class DuplicateClusterResult {
  clusterId!: string;
  matchReason!: 'EXACT_DOI' | 'FUZZY_TITLE_YEAR_AUTHOR' | string;
  confidence!: number;
  items!: DuplicateClusterItem[];
}
