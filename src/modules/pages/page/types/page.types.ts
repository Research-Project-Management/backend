/**
 * modules/pages/page/types/page.types.ts
 * Public parameter and document range types for the Page module.
 */

export interface PageDocRanges {
  labels?: Array<{ id: string; name?: string; color?: string }>;
  labelIds?: string[];
  status?: string;
  description?: string;
  [key: string]: unknown;
}

export interface UpdatePageMetadataParams {
  title?: string;
  description?: string;
  status?: 'draft' | 'published' | 'archived';
  compiler?: string;
  texlive?: string;
  spellLang?: string;
  rootDocId?: string;
}

export interface UpdatePageContentParams extends UpdatePageMetadataParams {
  content?: string;
  lines?: string[];
  version?: number;
  expectedRev?: number;
  expectedVersion?: number;
}

export interface CreatePageFileParams {
  title?: string;
  name?: string;
  content?: string;
}

export interface ImportFromProjectParams {
  sourceProjectId?: string;
  sourceFileId: string;
  targetName?: string;
  targetPath?: string;
  parentPageId?: string;
}
