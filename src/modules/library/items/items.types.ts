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
  'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn' | 'uri' | 'custom';

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
  extra?: string | null;
  extraFields?: Record<string, unknown>;
  creators?: CreatorCredit[];
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

export interface ItemTypeConversionPreview {
  sourceItemType: string;
  targetItemType: string;
  preservedFields: string[];
  mappedFields: {
    sourceField: string;
    targetField: string;
    baseSemantic?: string;
  }[];
  clearedFields: string[];
  fieldDiffs: ItemTypeConversionFieldDiff[];
  creatorRoleDiffs: ItemTypeConversionRoleDiff[];
  canConvert: boolean;
  reasons?: string[];
}
