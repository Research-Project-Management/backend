import {
  IsString,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  IsNumber,
  IsBoolean,
  IsObject,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { PartialType, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  creatorType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  fieldMode?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shortName?: string;

  @IsOptional()
  @IsNumber()
  orderIndex?: number;
}

export class CreateItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @IsString()
  @MaxLength(2000)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  author?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  authors?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreatorDto)
  creators?: CreatorDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreatorDto)
  contributors?: CreatorDto[];

  @IsOptional()
  @IsNumber()
  year?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  doi?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  abstract?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  abstractNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  itemType?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  editors?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  journal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  publicationTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  publicationDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  publisher?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  place?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  volume?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  issue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  section?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  partNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  partTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  pages?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  series?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  seriesTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  seriesText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  seriesNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  issn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  isbn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  pmid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  pmcid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  arxivId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  arxiv?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  journalAbbr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  journalAbbreviation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  shortTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  rights?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  license?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  citationKey?: string;

  @IsOptional()
  @IsNumber()
  citationCount?: number | null;

  @IsOptional()
  @IsNumber()
  referenceCount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  openAccessPdfUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  libraryCatalog?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  archive?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  archiveLocation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  callNumber?: string;

  @IsOptional()
  accessedAt?: Date | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  accessDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  extra?: string;

  @IsOptional()
  @ArrayMaxSize(500)
  notes?: unknown[] | string[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  labels?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  keywords?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  keywordsList?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  fileUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  filename?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mimeType?: string;

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  collectionId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  collectionIds?: string[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  collections?: string[] | null;

  // Type-specific field aliases/direct inputs supported across 37 item types
  @IsOptional() @IsString() @MaxLength(1000) edition?: string;
  @IsOptional() @IsString() @MaxLength(255) numPages?: string;
  @IsOptional() @IsString() @MaxLength(255) numberOfVolumes?: string;
  @IsOptional() @IsString() @MaxLength(500) thesisType?: string;
  @IsOptional() @IsString() @MaxLength(1000) university?: string;
  @IsOptional() @IsString() @MaxLength(500) reportNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) reportType?: string;
  @IsOptional() @IsString() @MaxLength(1000) institution?: string;
  @IsOptional() @IsString() @MaxLength(1000) organization?: string;
  @IsOptional() @IsString() @MaxLength(500) identifier?: string;
  @IsOptional() @IsString() @MaxLength(500) genre?: string;
  @IsOptional() @IsString() @MaxLength(1000) repository?: string;
  @IsOptional() @IsString() @MaxLength(1000) repositoryLocation?: string;
  @IsOptional() @IsString() @MaxLength(500) archiveID?: string;
  @IsOptional() @IsString() @MaxLength(500) format?: string;
  @IsOptional() @IsString() @MaxLength(255) versionNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) system?: string;
  @IsOptional() @IsString() @MaxLength(1000) company?: string;
  @IsOptional() @IsString() @MaxLength(255) programmingLanguage?: string;
  @IsOptional() @IsString() @MaxLength(500) standardNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) patentNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) applicationNumber?: string;
  @IsOptional() @IsString() @MaxLength(1000) issuingAuthority?: string;
  @IsOptional() @IsString() @MaxLength(255) filingDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) assignee?: string;
  @IsOptional() @IsString() @MaxLength(500) legalStatus?: string;
  @IsOptional() @IsString() @MaxLength(500) code?: string;
  @IsOptional() @IsString() @MaxLength(500) codeNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) publicLawNumber?: string;
  @IsOptional() @IsString() @MaxLength(255) dateEnacted?: string;
  @IsOptional() @IsString() @MaxLength(500) billNumber?: string;
  @IsOptional() @IsString() @MaxLength(255) codeVolume?: string;
  @IsOptional() @IsString() @MaxLength(255) codePages?: string;
  @IsOptional() @IsString() @MaxLength(1000) legislativeBody?: string;
  @IsOptional() @IsString() @MaxLength(500) reporter?: string;
  @IsOptional() @IsString() @MaxLength(255) reporterVolume?: string;
  @IsOptional() @IsString() @MaxLength(1000) court?: string;
  @IsOptional() @IsString() @MaxLength(500) docketNumber?: string;
  @IsOptional() @IsString() @MaxLength(255) firstPage?: string;
  @IsOptional() @IsString() @MaxLength(255) dateDecided?: string;
  @IsOptional() @IsString() @MaxLength(1000) committee?: string;
  @IsOptional() @IsString() @MaxLength(500) documentNumber?: string;
  @IsOptional() @IsString() @MaxLength(1000) websiteTitle?: string;
  @IsOptional() @IsString() @MaxLength(500) websiteType?: string;
  @IsOptional() @IsString() @MaxLength(1000) blogTitle?: string;
  @IsOptional() @IsString() @MaxLength(1000) forumTitle?: string;
  @IsOptional() @IsString() @MaxLength(500) postType?: string;
  @IsOptional() @IsString() @MaxLength(500) presentationType?: string;
  @IsOptional() @IsString() @MaxLength(1000) meetingName?: string;
  @IsOptional() @IsString() @MaxLength(500) letterType?: string;
  @IsOptional() @IsString() @MaxLength(500) manuscriptType?: string;
  @IsOptional() @IsString() @MaxLength(500) mapType?: string;
  @IsOptional() @IsString() @MaxLength(255) scale?: string;
  @IsOptional() @IsString() @MaxLength(500) artworkMedium?: string;
  @IsOptional() @IsString() @MaxLength(500) artworkSize?: string;
  @IsOptional() @IsString() @MaxLength(1000) distributor?: string;
  @IsOptional() @IsString() @MaxLength(500) videoRecordingFormat?: string;
  @IsOptional() @IsString() @MaxLength(500) audioRecordingFormat?: string;
  @IsOptional() @IsString() @MaxLength(255) runningTime?: string;
  @IsOptional() @IsString() @MaxLength(500) label?: string;
  @IsOptional() @IsString() @MaxLength(1000) studio?: string;
  @IsOptional() @IsString() @MaxLength(1000) network?: string;
  @IsOptional() @IsString() @MaxLength(1000) programTitle?: string;
  @IsOptional() @IsString() @MaxLength(255) episodeNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) podcastType?: string;
  @IsOptional() @IsString() @MaxLength(500) interviewMedium?: string;
  @IsOptional() @IsString() @MaxLength(1000) proceedingsTitle?: string;
  @IsOptional() @IsString() @MaxLength(1000) conferenceName?: string;
  @IsOptional() @IsString() @MaxLength(1000) eventPlace?: string;
  @IsOptional() @IsString() @MaxLength(1000) bookTitle?: string;
  @IsOptional() @IsString() @MaxLength(1000) dictionaryTitle?: string;
  @IsOptional() @IsString() @MaxLength(1000) encyclopediaTitle?: string;
  @IsOptional() @IsString() @MaxLength(255) originalDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) originalPublisher?: string;
  @IsOptional() @IsString() @MaxLength(1000) originalPlace?: string;
  @IsOptional() @IsString() @MaxLength(500) session?: string;
  @IsOptional() @IsString() @MaxLength(2000) history?: string;
  @IsOptional() @IsString() @MaxLength(1000) caseName?: string;
  @IsOptional() @IsString() @MaxLength(1000) subject?: string;
  @IsOptional() @IsString() @MaxLength(1000) nameOfAct?: string;
  @IsOptional() @IsString() @MaxLength(500) number?: string;
  @IsOptional() @IsString() @MaxLength(500) country?: string;
  @IsOptional() @IsString() @MaxLength(500) priorityNumbers?: string;
  @IsOptional() @IsString() @MaxLength(255) issueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) priorityDate?: string;
  @IsOptional() @IsString() @MaxLength(2000) references?: string;
  @IsOptional() @IsString() @MaxLength(500) audioFileType?: string;
  @IsOptional() @IsString() @MaxLength(500) medium?: string;
  @IsOptional() @IsString() @MaxLength(1000) sessionTitle?: string;
  @IsOptional() @IsString() @MaxLength(255) status?: string;
  @IsOptional() @IsString() @MaxLength(512) DOI?: string;
  @IsOptional() @IsString() @MaxLength(255) ISBN?: string;
  @IsOptional() @IsString() @MaxLength(255) ISSN?: string;
  @IsOptional() @IsString() @MaxLength(255) PMID?: string;
  @IsOptional() @IsString() @MaxLength(255) PMCID?: string;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : (value as string | undefined),
  )
  @IsString()
  @MaxLength(255)
  numberOfPages?: string;
  @IsOptional() @IsString() @MaxLength(255) archiveId?: string;
  @IsOptional() @IsString() @MaxLength(1000) authority?: string;
  @IsOptional() @IsString() @MaxLength(100000) bibtex?: string;
  @IsOptional() @IsString() @MaxLength(255) citeKey?: string;
  @IsOptional() @IsBoolean() isStarred?: boolean;
  @IsOptional() @IsBoolean() silent?: boolean;
  @IsOptional() @IsString() @MaxLength(50) readStatus?: string;
  @IsOptional() @IsNumber() rating?: number;
  @IsOptional() @IsBoolean() isMyPublication?: boolean;
  @IsOptional() @IsBoolean() isRetracted?: boolean;
  @IsOptional() @IsString() @MaxLength(255) retractionNature?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  retractionReason?: string[];
  @IsOptional() @IsString() @MaxLength(100) retractionDate?: string;
  @IsOptional() @IsString() @MaxLength(512) retractionNoticeDoi?: string;
  @IsOptional() retractionDetails?: Record<string, unknown> | null;
  @IsOptional() @IsString() @MaxLength(100) retractionCheckedAt?: string;
  @IsOptional() identifiers?:
    Record<string, unknown> | Array<Record<string, unknown>>;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  lockedFields?: string[];
  @IsOptional() fieldProvenance?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isFilenameTitle?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  demotedExtraLines?: string[];
  @IsOptional() metadata?: Record<string, unknown>;
  @IsOptional() relations?: Record<string, unknown>;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  seeAlso?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  attachments?: Array<{
    id?: string;
    title?: string;
    filename?: string;
    url?: string;
    fileId?: string | null;
    fileHash?: string | null;
    size?: number;
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
  @MaxLength(100)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetItemType?: string;

  @IsOptional()
  @IsBoolean()
  retainUnmappedInExtra?: boolean;
}

export class TypeConversionDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @MaxLength(100000)
  citations?: string;

  @ApiPropertyOptional({
    description: 'Alias for citations',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100000)
  rawCitations?: string;
}

export class BulkPurgeItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to permanently delete from library/trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  itemIds!: string[];
}

export class BulkTrashItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to move to trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  itemIds!: string[];
}

export class BulkRestoreItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to restore from trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  itemIds!: string[];
}
