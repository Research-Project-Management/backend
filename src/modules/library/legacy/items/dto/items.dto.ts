import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { AttachmentType } from '@prisma/client';
import { CreatorInput as LibraryCreatorInput } from '@/modules/library/legacy/metadata/types/metadata.types';

export class IngestCatalogItemDto {
  @IsString()
  @IsOptional()
  source?: 'upload' | 'storage' | 'identifier';

  @IsString()
  @IsOptional()
  fileId?: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  fileUrl?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsArray()
  @IsOptional()
  creators?: LibraryCreatorInput[];

  @IsNumber()
  @IsOptional()
  year?: number;

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;

  @IsArray()
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  itemType?: string;

  @IsString()
  @IsOptional()
  abstract?: string;

  @IsString()
  @IsOptional()
  abstractNote?: string;

  @IsString()
  @IsOptional()
  journal?: string;

  @IsString()
  @IsOptional()
  publicationTitle?: string;

  @IsString()
  @IsOptional()
  publisher?: string;

  @IsString()
  @IsOptional()
  place?: string;

  @IsString()
  @IsOptional()
  volume?: string;

  @IsString()
  @IsOptional()
  issue?: string;

  @IsString()
  @IsOptional()
  section?: string;

  @IsString()
  @IsOptional()
  partNumber?: string;

  @IsString()
  @IsOptional()
  partTitle?: string;

  @IsString()
  @IsOptional()
  pages?: string;

  @IsString()
  @IsOptional()
  series?: string;

  @IsString()
  @IsOptional()
  seriesTitle?: string;

  @IsString()
  @IsOptional()
  seriesText?: string;

  @IsString()
  @IsOptional()
  issn?: string;

  @IsString()
  @IsOptional()
  isbn?: string;

  @IsString()
  @IsOptional()
  pmid?: string;

  @IsString()
  @IsOptional()
  pmcid?: string;

  @IsString()
  @IsOptional()
  arxivId?: string;

  @IsString()
  @IsOptional()
  arxiv?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  journalAbbr?: string;

  @IsString()
  @IsOptional()
  shortTitle?: string;

  @IsString()
  @IsOptional()
  rights?: string;

  @IsString()
  @IsOptional()
  license?: string;

  @IsString()
  @IsOptional()
  date?: string;

  @IsString()
  @IsOptional()
  publicationDate?: string;

  @IsString()
  @IsOptional()
  accessDate?: string;

  @IsString()
  @IsOptional()
  extra?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  editors?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  keywords?: string[];
}

export class UploadCatalogItemDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  title!: string;

  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  fileUrl?: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsString()
  @IsOptional()
  fileId?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsArray()
  @IsOptional()
  creators?: LibraryCreatorInput[];

  @IsNumber()
  @IsOptional()
  year?: number;

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  abstract?: string;

  @IsString()
  @IsOptional()
  abstractNote?: string;

  @IsString()
  @IsOptional()
  journal?: string;

  @IsString()
  @IsOptional()
  publisher?: string;

  @IsArray()
  @IsOptional()
  keywords?: string[];

  @IsArray()
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  volume?: string;

  @IsString()
  @IsOptional()
  issue?: string;

  @IsString()
  @IsOptional()
  pages?: string;

  @IsString()
  @IsOptional()
  issn?: string;

  @IsString()
  @IsOptional()
  isbn?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  itemType?: string;

  @IsString()
  @IsOptional()
  date?: string;

  @IsString()
  @IsOptional()
  accessDate?: string;

  @IsOptional()
  accessedAt?: string | Date;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  journalAbbr?: string;

  @IsString()
  @IsOptional()
  shortTitle?: string;

  @IsString()
  @IsOptional()
  rights?: string;

  @IsString()
  @IsOptional()
  license?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;

  @IsString()
  @IsOptional()
  publicationTitle?: string;

  @IsString()
  @IsOptional()
  publicationDate?: string;

  @IsString()
  @IsOptional()
  place?: string;

  @IsString()
  @IsOptional()
  section?: string;

  @IsString()
  @IsOptional()
  partNumber?: string;

  @IsString()
  @IsOptional()
  partTitle?: string;

  @IsString()
  @IsOptional()
  series?: string;

  @IsString()
  @IsOptional()
  seriesTitle?: string;

  @IsString()
  @IsOptional()
  seriesText?: string;

  @IsString()
  @IsOptional()
  pmid?: string;

  @IsString()
  @IsOptional()
  pmcid?: string;

  @IsString()
  @IsOptional()
  libraryCatalog?: string;

  @IsString()
  @IsOptional()
  archive?: string;

  @IsString()
  @IsOptional()
  archiveLocation?: string;

  @IsString()
  @IsOptional()
  callNumber?: string;

  @IsString()
  @IsOptional()
  extra?: string;

  @IsString()
  @IsOptional()
  author?: string;

  @IsString()
  @IsOptional()
  arxivId?: string;

  @IsString()
  @IsOptional()
  arxiv?: string;

  @IsString()
  @IsOptional()
  journalAbbreviation?: string;

  @IsString()
  @IsOptional()
  seriesNumber?: string;

  @IsOptional()
  keywordsList?: string[];

  @IsOptional()
  crossrefEnriched?: boolean;

  @IsOptional()
  extraFields?: any;

  @IsOptional()
  provenance?: any;

  @IsOptional()
  subject?: string;

  @IsOptional()
  creator?: string;

  @IsOptional()
  producer?: string;

  @IsOptional()
  creationDate?: string;

  @IsOptional()
  modDate?: string;

  @IsOptional()
  pageCount?: number;

  @IsOptional()
  copyright?: string;

  @IsOptional()
  numPages?: string | number;

  @IsOptional()
  numberOfVolumes?: string | number;

  @IsOptional()
  edition?: string;

  @IsOptional()
  conferenceName?: string;

  @IsOptional()
  proceedingsTitle?: string;

  @IsOptional()
  bookTitle?: string;

  @IsOptional()
  university?: string;

  @IsOptional()
  institution?: string;

  @IsOptional()
  country?: string;

  @IsOptional()
  assignee?: string;

  @IsOptional()
  issuingAuthority?: string;

  @IsOptional()
  filingDate?: string;

  @IsOptional()
  websiteTitle?: string;

  @IsOptional()
  websiteType?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  editors?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  notes?: string[];
}

export class AddAttachmentDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsNotEmpty({ message: 'Attachment URL is required' })
  url!: string;

  @IsString()
  @IsOptional()
  fileId?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsEnum(AttachmentType)
  @IsOptional()
  attachmentType?: AttachmentType;
}

export class ImportStorageCatalogItemDto {
  @IsString()
  @IsNotEmpty({ message: 'File ID is required' })
  fileId!: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsArray()
  @IsOptional()
  creators?: LibraryCreatorInput[];

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;

  @IsArray()
  @IsOptional()
  tags?: string[];
}

export class UpdateCatalogItemDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsArray()
  @IsOptional()
  creators?: LibraryCreatorInput[];

  @IsNumber()
  @IsOptional()
  year?: number;

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  abstract?: string;

  @IsString()
  @IsOptional()
  abstractNote?: string;

  @IsArray()
  @IsOptional()
  keywords?: string[];

  @IsArray()
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  date?: string;

  @IsString()
  @IsOptional()
  accessDate?: string;

  @IsString()
  @IsOptional()
  itemType?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsArray()
  @IsOptional()
  editors?: string[];

  @IsString()
  @IsOptional()
  journal?: string;

  @IsString()
  @IsOptional()
  publicationTitle?: string;

  @IsString()
  @IsOptional()
  publicationDate?: string;

  @IsString()
  @IsOptional()
  publisher?: string;

  @IsString()
  @IsOptional()
  place?: string;

  @IsArray()
  @IsOptional()
  labels?: string[];

  @IsString()
  @IsOptional()
  volume?: string;

  @IsString()
  @IsOptional()
  issue?: string;

  @IsString()
  @IsOptional()
  section?: string;

  @IsString()
  @IsOptional()
  pages?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  journalAbbr?: string;

  @IsString()
  @IsOptional()
  shortTitle?: string;

  @IsString()
  @IsOptional()
  series?: string;

  @IsString()
  @IsOptional()
  seriesTitle?: string;

  @IsString()
  @IsOptional()
  issn?: string;

  @IsString()
  @IsOptional()
  isbn?: string;

  @IsString()
  @IsOptional()
  pmid?: string;

  @IsString()
  @IsOptional()
  pmcid?: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  rights?: string;

  @IsString()
  @IsOptional()
  license?: string;

  @IsString()
  @IsOptional()
  bookTitle?: string;

  @IsString()
  @IsOptional()
  proceedingsTitle?: string;

  @IsString()
  @IsOptional()
  conferenceName?: string;

  @IsString()
  @IsOptional()
  websiteTitle?: string;

  @IsString()
  @IsOptional()
  websiteType?: string;

  @IsString()
  @IsOptional()
  university?: string;

  @IsString()
  @IsOptional()
  institution?: string;

  @IsString()
  @IsOptional()
  country?: string;

  @IsString()
  @IsOptional()
  assignee?: string;

  @IsString()
  @IsOptional()
  issuingAuthority?: string;

  @IsString()
  @IsOptional()
  patentNumber?: string;

  @IsString()
  @IsOptional()
  applicationNumber?: string;

  @IsString()
  @IsOptional()
  reportNumber?: string;

  @IsString()
  @IsOptional()
  reportType?: string;

  @IsString()
  @IsOptional()
  thesisType?: string;

  @IsString()
  @IsOptional()
  genre?: string;

  @IsString()
  @IsOptional()
  edition?: string;

  @IsString()
  @IsOptional()
  numPages?: string;

  @IsString()
  @IsOptional()
  numberOfVolumes?: string;

  @IsString()
  @IsOptional()
  seriesNumber?: string;

  @IsString()
  @IsOptional()
  seriesText?: string;

  @IsString()
  @IsOptional()
  filingDate?: string;

  @IsString()
  @IsOptional()
  legalStatus?: string;

  @IsString()
  @IsOptional()
  versionNumber?: string;

  @IsString()
  @IsOptional()
  libraryCatalog?: string;

  @IsString()
  @IsOptional()
  archive?: string;

  @IsString()
  @IsOptional()
  archiveLocation?: string;

  @IsString()
  @IsOptional()
  callNumber?: string;

  @IsString()
  @IsOptional()
  extra?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  notes?: string[];
}

export class MergeCatalogItemsDto {
  @IsString()
  @IsNotEmpty({ message: 'Master catalog item ID is required' })
  masterId!: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ message: 'Source catalog item IDs array is required' })
  sourceItemIds!: string[];
}

// Aliases for seamless backward compatibility
export class IngestPaperDto extends IngestCatalogItemDto {}
export class UploadPaperDto extends UploadCatalogItemDto {}
export class UpdatePaperDto extends UpdateCatalogItemDto {}
export class ImportStoragePaperDto extends ImportStorageCatalogItemDto {}
export class MergePapersDto extends MergeCatalogItemsDto {}
