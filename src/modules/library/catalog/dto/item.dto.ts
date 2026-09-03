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
  @IsNumber()
  citationCount?: number | null;

  @IsOptional()
  @IsNumber()
  influentialCitationCount?: number | null;

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
  @IsBoolean()
  crossrefEnriched?: boolean;

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

  @IsOptional()
  extraFields?: Record<string, any>;

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
  @IsNumber()
  citationCount?: number | null;

  @IsOptional()
  @IsNumber()
  influentialCitationCount?: number | null;

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

  @IsOptional()
  extraFields?: Record<string, any>;

  @IsOptional()
  provenance?: any;

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;
}

export class TypeConversionPreviewDto {
  @IsString()
  targetItemType!: string;
}

export class TypeConversionDto {
  @IsString()
  targetItemType!: string;

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;

  @IsOptional()
  customFieldOverrides?: Record<string, any>;
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
