// ── Creator & Contributor Types ──────────────────────────────────────────────
export type CreatorType =
  | 'author'
  | 'editor'
  | 'translator'
  | 'contributor'
  | 'advisor'
  | 'reviewer'
  | 'seriesEditor'
  | 'bookAuthor'
  | 'reviewedAuthor'
  | 'inventor'
  | 'attorneyAgent'
  | 'director'
  | 'producer'
  | 'scriptwriter'
  | 'presenter'
  | 'counsel'
  | 'interviewee'
  | 'interviewer'
  | 'cartographer'
  | 'programmer'
  | 'artist'
  | 'recipient'
  | 'performer'
  | 'composer'
  | 'wordsBy'
  | 'guest'
  | 'castMember'
  | 'podcaster'
  | 'sponsor'
  | 'cosponsor'
  | 'commenter'
  | (string & {});

export interface CreatorCredit {
  id?: string;
  orderIndex: number;
  creatorType: CreatorType;
  firstName?: string;
  lastName?: string;
  fullName: string;
}

export interface CreatorCreditInput {
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  creatorType?: CreatorType;
  orderIndex?: number;
}

export type CreatorInput = CreatorCreditInput;

// ── Identifier Schemes ───────────────────────────────────────────────────────
export type IdentifierScheme =
  | 'doi'
  | 'arxiv'
  | 'pmid'
  | 'pmcid'
  | 'isbn'
  | 'issn'
  | 'uri'
  | 'custom';

export interface ItemIdentifier {
  id?: string;
  type: IdentifierScheme;
  value: string;
  canonicalUri?: string;
}

export interface ItemIdentifierInput {
  type: IdentifierScheme;
  value: string;
  canonicalUri?: string;
}

// ── Item Relations ──────────────────────────────────────────────────────────
export type ItemRelationType =
  | 'cites'
  | 'cited_by'
  | 'replicates'
  | 'extends'
  | 'is_preprint_of'
  | 'is_published_version_of'
  | 'is_translation_of'
  | 'supplements';

export interface ItemRelation {
  id: string;
  workspaceId: string;
  sourceItemId: string;
  targetItemId: string;
  relationType: ItemRelationType;
  description?: string;
  createdAt: Date;
}

export interface ItemRelationInput {
  targetItemId: string;
  relationType: ItemRelationType;
  description?: string;
}

// ── Catalog Item Domain Models & Inputs ──────────────────────────────────────
export interface CatalogItemSummary {
  id: string;
  workspaceId: string;
  title: string;
  itemType?: string;
  year?: number | null;
  doi?: string | null;
  primaryAuthors: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemMetadata {
  title: string;
  itemType?: string;
  year?: number | null;
  publicationDate?: string | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  place?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  section?: string | null;
  series?: string | null;
  seriesTitle?: string | null;
  abstract?: string | null;
  url?: string | null;
  language?: string | null;
  shortTitle?: string | null;
  journalAbbr?: string | null;
  rights?: string | null;
  license?: string | null;
  citationKey?: string | null;
  libraryCatalog?: string | null;
  archive?: string | null;
  archiveLocation?: string | null;
  callNumber?: string | null;
  doi?: string | null;
  arxivId?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  isbn?: string | null;
  issn?: string | null;
  extra?: string | null;
  extraFields?: Record<string, unknown>;
  creators?: CreatorCredit[];
  contributors?: any[];
  identifiers?: ItemIdentifier[];
}

export interface CreateCatalogItemInput {
  title: string;
  itemType?: string;
  year?: number | null;
  doi?: string;
  abstract?: string;
  authors?: string[];
  creators?: CreatorCredit[];
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  extra?: string;
  extraFields?: Record<string, unknown>;
  notes?: Record<string, unknown>[] | null;
  labels?: string[];
  keywords?: string[];
  fileUrl?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  collectionId?: string | null;
  uploadedById: string;
}

export interface UpdateCatalogItemInput {
  title?: string;
  itemType?: string;
  year?: number | null;
  doi?: string;
  abstract?: string;
  authors?: string[];
  creators?: CreatorCredit[];
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  extra?: string;
  extraFields?: Record<string, unknown>;
  notes?: Record<string, unknown>[] | null;
  labels?: string[];
  keywords?: string[];
  collectionId?: string | null;
  expectedVersion?: number;
}

// ── Item Type Conversion Types ──────────────────────────────────────────────
export interface ItemTypeConversionFieldDiff {
  key: string;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  status: 'preserved' | 'mapped' | 'cleared';
  baseSemantic?: string;
}

export interface ItemTypeConversionRoleDiff {
  creatorId?: string;
  name: string;
  sourceRole: string;
  targetRole: string;
  changed: boolean;
}

export interface FieldMappingChange {
  fromField: string;
  toField: string;
  value: unknown;
  rule: 'direct' | 'base-semantic' | 'special-rule';
}

export interface DroppedField {
  field: string;
  label: string;
  value: unknown;
}

export interface CreatorRoleChange {
  creator: Record<string, unknown>;
  fromRole: string;
  toRole: string;
  reason: 'preserved' | 'primary-fallback' | 'secondary-fallback';
}

export interface TypeConversionPreview {
  sourceType: string;
  targetType: string;
  preservedFields: string[];
  mappedFields: FieldMappingChange[];
  droppedFields: DroppedField[];
  creatorChanges: CreatorRoleChange[];
  projectedItem: Record<string, any>;
  unmappedRetained: Record<string, any>;
  hasLoss: boolean;
}

export interface ConvertTypeOptions {
  expectedVersion?: number;
  retainUnmappedInExtra?: boolean;
}



// ── Persistence Layer Data Transfer Shapes ─────────────────────────────────
export interface CreateCatalogItemData {
  title: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  itemType?: string;
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  type?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  accessDate?: string;
  extra?: string;
  notes?: any;
  labels?: string[];
  keywords?: string[];
  fileUrl?: string;
  fileId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  collectionId?: string | null;
  collectionIds?: string[] | null;
  uploadedById: string;
  contributors?: any;
  creators?: any[];
  extraFields?: Record<string, any>;
  identifier?: string;
  organization?: string;
  arxivId?: string;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
}

export interface UpdateCatalogItemData {
  title?: string;
  authors?: string[];
  creators?: any[];
  extraFields?: Record<string, any>;
  year?: number | null;
  doi?: string;
  arxivId?: string;
  abstract?: string;
  abstractNote?: string;
  itemType?: string;
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  type?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  accessDate?: string;
  extra?: string;
  notes?: any;
  labels?: string[];
  keywords?: string[];
  tags?: string[];
  collectionId?: string | null;
  collectionIds?: string[] | null;
  edition?: string;
  numPages?: string;
  numberOfVolumes?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  eventPlace?: string;
  websiteTitle?: string;
  websiteType?: string;
  university?: string;
  institution?: string;
  country?: string;
  assignee?: string;
  issuingAuthority?: string;
  patentNumber?: string;
  applicationNumber?: string;
  reportNumber?: string;
  reportType?: string;
  thesisType?: string;
  genre?: string;
  filingDate?: string;
  legalStatus?: string;
  versionNumber?: string;
  blogTitle?: string;
  forumTitle?: string;
  postType?: string;
  presentationType?: string;
  meetingName?: string;
  letterType?: string;
  manuscriptType?: string;
  mapType?: string;
  artworkMedium?: string;
  artworkSize?: string;
  distributor?: string;
  runningTime?: string;
  programTitle?: string;
  episodeNumber?: string;
  podcastType?: string;
  interviewMedium?: string;
  dictionaryTitle?: string;
  encyclopediaTitle?: string;
  originalDate?: string;
  originalPublisher?: string;
  originalPlace?: string;
  court?: string;
  docketNumber?: string;
  firstPage?: string;
  dateDecided?: string;
  reporter?: string;
  reporterVolume?: string;
  codeNumber?: string;
  publicLawNumber?: string;
  dateEnacted?: string;
  billNumber?: string;
  legislativeBody?: string;
  programmingLanguage?: string;
  standardNumber?: string;
  identifier?: string;
  organization?: string;
}
