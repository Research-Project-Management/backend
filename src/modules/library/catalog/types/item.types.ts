export * from './creator.types';
export * from './identifier.types';
export * from './relation.types';

import { CreatorCredit } from './creator.types';
import { ItemIdentifier } from './identifier.types';

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
  notes?: any;
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
  notes?: any;
  labels?: string[];
  keywords?: string[];
  collectionId?: string | null;
}

