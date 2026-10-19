import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { PartialType, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatorDto {
  @IsOptional()
  @IsString()
  id?: string;

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
  @Type(() => Number)
  @IsNumber()
  fieldMode?: number;

  @IsOptional()
  @IsString()
  shortName?: string;

  @IsOptional()
  @IsNumber()
  orderIndex?: number;
}

export class CreateItemDto {
  @IsOptional()
  @IsString()
  projectId?: string;

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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatorDto)
  contributors?: CreatorDto[];

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
  @IsNumber()
  citationCount?: number | null;

  @IsOptional()
  @IsNumber()
  referenceCount?: number | null;

  @IsOptional()
  @IsString()
  openAccessPdfUrl?: string | null;

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
  notes?: unknown[] | string[] | null;

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
  fileId?: string;

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
  @IsArray()
  @IsString({ each: true })
  collectionIds?: string[] | null;

  // Type-specific field aliases/direct inputs supported across 37 item types
  @IsOptional() @IsString() edition?: string;
  @IsOptional() @IsString() numPages?: string;
  @IsOptional() @IsString() numberOfVolumes?: string;
  @IsOptional() @IsString() thesisType?: string;
  @IsOptional() @IsString() university?: string;
  @IsOptional() @IsString() reportNumber?: string;
  @IsOptional() @IsString() reportType?: string;
  @IsOptional() @IsString() institution?: string;
  @IsOptional() @IsString() organization?: string;
  @IsOptional() @IsString() identifier?: string;
  @IsOptional() @IsString() genre?: string;
  @IsOptional() @IsString() repository?: string;
  @IsOptional() @IsString() repositoryLocation?: string;
  @IsOptional() @IsString() archiveID?: string;
  @IsOptional() @IsString() format?: string;
  @IsOptional() @IsString() versionNumber?: string;
  @IsOptional() @IsString() system?: string;
  @IsOptional() @IsString() company?: string;
  @IsOptional() @IsString() programmingLanguage?: string;
  @IsOptional() @IsString() standardNumber?: string;
  @IsOptional() @IsString() patentNumber?: string;
  @IsOptional() @IsString() applicationNumber?: string;
  @IsOptional() @IsString() issuingAuthority?: string;
  @IsOptional() @IsString() filingDate?: string;
  @IsOptional() @IsString() assignee?: string;
  @IsOptional() @IsString() legalStatus?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() codeNumber?: string;
  @IsOptional() @IsString() publicLawNumber?: string;
  @IsOptional() @IsString() dateEnacted?: string;
  @IsOptional() @IsString() billNumber?: string;
  @IsOptional() @IsString() codeVolume?: string;
  @IsOptional() @IsString() codePages?: string;
  @IsOptional() @IsString() legislativeBody?: string;
  @IsOptional() @IsString() reporter?: string;
  @IsOptional() @IsString() reporterVolume?: string;
  @IsOptional() @IsString() court?: string;
  @IsOptional() @IsString() docketNumber?: string;
  @IsOptional() @IsString() firstPage?: string;
  @IsOptional() @IsString() dateDecided?: string;
  @IsOptional() @IsString() committee?: string;
  @IsOptional() @IsString() documentNumber?: string;
  @IsOptional() @IsString() websiteTitle?: string;
  @IsOptional() @IsString() websiteType?: string;
  @IsOptional() @IsString() blogTitle?: string;
  @IsOptional() @IsString() forumTitle?: string;
  @IsOptional() @IsString() postType?: string;
  @IsOptional() @IsString() presentationType?: string;
  @IsOptional() @IsString() meetingName?: string;
  @IsOptional() @IsString() letterType?: string;
  @IsOptional() @IsString() manuscriptType?: string;
  @IsOptional() @IsString() mapType?: string;
  @IsOptional() @IsString() scale?: string;
  @IsOptional() @IsString() artworkMedium?: string;
  @IsOptional() @IsString() artworkSize?: string;
  @IsOptional() @IsString() distributor?: string;
  @IsOptional() @IsString() videoRecordingFormat?: string;
  @IsOptional() @IsString() audioRecordingFormat?: string;
  @IsOptional() @IsString() runningTime?: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() studio?: string;
  @IsOptional() @IsString() network?: string;
  @IsOptional() @IsString() programTitle?: string;
  @IsOptional() @IsString() episodeNumber?: string;
  @IsOptional() @IsString() podcastType?: string;
  @IsOptional() @IsString() interviewMedium?: string;
  @IsOptional() @IsString() proceedingsTitle?: string;
  @IsOptional() @IsString() conferenceName?: string;
  @IsOptional() @IsString() eventPlace?: string;
  @IsOptional() @IsString() bookTitle?: string;
  @IsOptional() @IsString() dictionaryTitle?: string;
  @IsOptional() @IsString() encyclopediaTitle?: string;
  @IsOptional() @IsString() originalDate?: string;
  @IsOptional() @IsString() originalPublisher?: string;
  @IsOptional() @IsString() originalPlace?: string;
  @IsOptional() @IsString() session?: string;
  @IsOptional() @IsString() history?: string;
  @IsOptional() @IsString() caseName?: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() nameOfAct?: string;
  @IsOptional() @IsString() number?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() priorityNumbers?: string;
  @IsOptional() @IsString() issueDate?: string;
  @IsOptional() @IsString() priorityDate?: string;
  @IsOptional() @IsString() references?: string;
  @IsOptional() @IsString() audioFileType?: string;
  @IsOptional() @IsString() sessionTitle?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() DOI?: string;
  @IsOptional() @IsString() ISBN?: string;
  @IsOptional() @IsString() ISSN?: string;
  @IsOptional() @IsString() PMID?: string;
  @IsOptional() @IsString() PMCID?: string;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : (value as string | undefined),
  )
  @IsString()
  numberOfPages?: string;
  @IsOptional() @IsString() archiveId?: string;
  @IsOptional() @IsString() authority?: string;
  @IsOptional() @IsString() bibtex?: string;
  @IsOptional() @IsString() citeKey?: string;
  @IsOptional() @IsBoolean() isStarred?: boolean;
  @IsOptional() @IsString() readStatus?: string;
  @IsOptional() @IsNumber() rating?: number;
  @IsOptional() @IsBoolean() isMyPublication?: boolean;
  @IsOptional() @IsBoolean() isRetracted?: boolean;
  @IsOptional() @IsString() retractionNature?: string;
  @IsOptional() retractionDetails?: Record<string, unknown> | null;
  @IsOptional() @IsString() retractionCheckedAt?: string;
  @IsOptional() metadata?: Record<string, unknown>;
  @IsOptional() relations?: Record<string, unknown>;
  @IsOptional() seeAlso?: string[];
  @IsOptional()
  @IsArray()
  attachments?: Array<{
    id?: string;
    title?: string;
    filename?: string;
    url?: string;
    fileId?: string | null;
    fileHash?: string | null;
    fileSize?: number;
    mimeType?: string;
    linkMode?: string;
    metadata?: Record<string, unknown>;
  }>;

  @IsOptional()
  extraFields?: Record<string, unknown>;

  @IsOptional()
  provenance?: Record<string, unknown>;
}

export class UpdateItemDto extends PartialType(CreateItemDto) {
  @IsOptional()
  @IsNumber()
  expectedVersion?: number;
}

export class TypeConversionPreviewDto {
  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetItemType?: string;

  @IsOptional()
  @IsBoolean()
  retainUnmappedInExtra?: boolean;
}

export class TypeConversionDto {
  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetItemType?: string;

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;

  @IsOptional()
  @IsBoolean()
  retainUnmappedInExtra?: boolean;

  @IsOptional()
  @IsObject()
  customFieldOverrides?: Record<string, unknown>;
}

export { CursorPaginationQueryDto } from './item-query.dto';
export type {
  CursorPaginatedResult,
  DocumentBoundingBoxDto,
  DocumentSectionDto,
  DocumentFigureDto,
  DocumentTableDto,
  DocumentFormulaDto,
  DocumentReferenceDto,
  DocumentFulltextResponse,
} from './item-query.dto';

export class ParseCitationsDto {
  @ApiPropertyOptional({
    description:
      'Raw unformatted citation text or multi-line bibliography string to parse via citation parser',
    example:
      'Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, L., & Polosukhin, I. (2017). Attention is all you need. Advances in neural information processing systems, 30.',
  })
  @IsOptional()
  @IsString()
  citations?: string;

  @ApiPropertyOptional({
    description: 'Alias for citations',
  })
  @IsOptional()
  @IsString()
  rawCitations?: string;
}

export class BulkPurgeItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to permanently delete from library/trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];
}

export class BulkTrashItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to move to trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];
}

export class BulkRestoreItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to restore from trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];
}
