import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatorDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  creatorType?: string;

  @IsOptional()
  @IsNumber()
  orderIndex?: number;
}

export class CreateCatalogItemDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  author?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  authors?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatorDto)
  creators?: CreatorDto[];

  @IsOptional()
  @IsNumber()
  year?: number | null;

  @IsOptional()
  @IsString()
  doi?: string;

  @IsOptional()
  @IsString()
  abstract?: string;

  @IsOptional()
  @IsString()
  abstractNote?: string;

  @IsOptional()
  @IsString()
  itemType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  editors?: string[];

  @IsOptional()
  @IsString()
  journal?: string;

  @IsOptional()
  @IsString()
  publicationTitle?: string;

  @IsOptional()
  @IsString()
  publicationDate?: string;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  publisher?: string;

  @IsOptional()
  @IsString()
  place?: string;

  @IsOptional()
  @IsString()
  volume?: string;

  @IsOptional()
  @IsString()
  issue?: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  partNumber?: string;

  @IsOptional()
  @IsString()
  partTitle?: string;

  @IsOptional()
  @IsString()
  pages?: string;

  @IsOptional()
  @IsString()
  series?: string;

  @IsOptional()
  @IsString()
  seriesTitle?: string;

  @IsOptional()
  @IsString()
  seriesText?: string;

  @IsOptional()
  @IsString()
  seriesNumber?: string;

  @IsOptional()
  @IsString()
  issn?: string;

  @IsOptional()
  @IsString()
  isbn?: string;

  @IsOptional()
  @IsString()
  pmid?: string;

  @IsOptional()
  @IsString()
  pmcid?: string;

  @IsOptional()
  @IsString()
  arxivId?: string;

  @IsOptional()
  @IsString()
  arxiv?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  journalAbbr?: string;

  @IsOptional()
  @IsString()
  journalAbbreviation?: string;

  @IsOptional()
  @IsString()
  shortTitle?: string;

  @IsOptional()
  @IsString()
  rights?: string;

  @IsOptional()
  @IsString()
  license?: string;

  @IsOptional()
  @IsString()
  citationKey?: string;

  @IsOptional()
  @IsString()
  libraryCatalog?: string;

  @IsOptional()
  @IsString()
  archive?: string;

  @IsOptional()
  @IsString()
  archiveLocation?: string;

  @IsOptional()
  @IsString()
  callNumber?: string;

  @IsOptional()
  accessedAt?: Date | null;

  @IsOptional()
  @IsString()
  accessDate?: string;

  @IsOptional()
  @IsString()
  extra?: string;

  @IsOptional()
  notes?: any;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywordsList?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  fileUrl?: string;

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsString()
  collectionId?: string | null;

  @IsOptional()
  @IsBoolean()
  crossrefEnriched?: boolean;

  @IsOptional()
  extraFields?: any;

  @IsOptional()
  provenance?: any;
}

export class UpdateCatalogItemDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  author?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  authors?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatorDto)
  creators?: CreatorDto[];

  @IsOptional()
  @IsNumber()
  year?: number | null;

  @IsOptional()
  @IsString()
  doi?: string;

  @IsOptional()
  @IsString()
  abstract?: string;

  @IsOptional()
  @IsString()
  abstractNote?: string;

  @IsOptional()
  @IsString()
  itemType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  editors?: string[];

  @IsOptional()
  @IsString()
  journal?: string;

  @IsOptional()
  @IsString()
  publicationTitle?: string;

  @IsOptional()
  @IsString()
  publicationDate?: string;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  publisher?: string;

  @IsOptional()
  @IsString()
  place?: string;

  @IsOptional()
  @IsString()
  volume?: string;

  @IsOptional()
  @IsString()
  issue?: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  partNumber?: string;

  @IsOptional()
  @IsString()
  partTitle?: string;

  @IsOptional()
  @IsString()
  pages?: string;

  @IsOptional()
  @IsString()
  series?: string;

  @IsOptional()
  @IsString()
  seriesTitle?: string;

  @IsOptional()
  @IsString()
  seriesText?: string;

  @IsOptional()
  @IsString()
  seriesNumber?: string;

  @IsOptional()
  @IsString()
  issn?: string;

  @IsOptional()
  @IsString()
  isbn?: string;

  @IsOptional()
  @IsString()
  pmid?: string;

  @IsOptional()
  @IsString()
  pmcid?: string;

  @IsOptional()
  @IsString()
  arxivId?: string;

  @IsOptional()
  @IsString()
  arxiv?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  journalAbbr?: string;

  @IsOptional()
  @IsString()
  journalAbbreviation?: string;

  @IsOptional()
  @IsString()
  shortTitle?: string;

  @IsOptional()
  @IsString()
  rights?: string;

  @IsOptional()
  @IsString()
  license?: string;

  @IsOptional()
  @IsString()
  citationKey?: string;

  @IsOptional()
  @IsString()
  libraryCatalog?: string;

  @IsOptional()
  @IsString()
  archive?: string;

  @IsOptional()
  @IsString()
  archiveLocation?: string;

  @IsOptional()
  @IsString()
  callNumber?: string;

  @IsOptional()
  accessedAt?: Date | null;

  @IsOptional()
  @IsString()
  accessDate?: string;

  @IsOptional()
  @IsString()
  extra?: string;

  @IsOptional()
  notes?: any;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywordsList?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  collectionId?: string | null;

  @IsOptional()
  @IsBoolean()
  crossrefEnriched?: boolean;

  @IsOptional()
  extraFields?: any;

  @IsOptional()
  provenance?: any;

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;
}

export class BulkDeleteCatalogItemsDto {
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];
}

export class BulkMoveCatalogItemsDto {
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];

  @IsOptional()
  @IsString()
  targetCollectionId?: string | null;
}

export class BulkTagCatalogItemsDto {
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];

  @IsArray()
  @IsString({ each: true })
  tagIds!: string[];
}
