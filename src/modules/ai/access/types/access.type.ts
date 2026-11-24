export interface ResolvedSpaceScope {
  spaceId: string;
  projectId: string | null;
}

export interface ResolvedPageScope extends ResolvedSpaceScope {
  canonicalPageId: string;
  titleHint: string | null;
}

export interface ChatOwnershipRecord {
  id: string;
  createdById: string;
  spaceId: string;
  title: string;
}

export interface LlmOverridePayload {
  api_key: string;
  model?: string;
  base_url?: string;
}

export interface UserProfileContext {
  name?: string;
  email?: string;
  institution?: string;
}

export interface ResolvedChatDocuments {
  resolvedDocumentIds: string[];
  enrichedSources: EnrichedAttachedSource[];
}

export interface ChatTurnAccess {
  spaceId: string;
  projectId: string | null;
  canonicalPageId?: string;
  titleHint?: string | null;
  resolvedDocumentIds: string[];
  enrichedSources: EnrichedAttachedSource[];
  existingChat: ChatOwnershipRecord | null;
  llmOverride?: LlmOverridePayload | null;
  userProfile?: UserProfileContext | null;
}

export interface EnrichedAttachedSource {
  kind: 'library' | 'upload' | 'paper';
  title: string;
  source_id: string | null;
  source_type: 'upload' | 'file' | null;
  item_id: string | null;
  file_id: string | null;
  has_pdf: boolean;
  indexed: boolean;
}

export interface ResolvedPaperTarget {
  itemId?: string | null;
  fileId?: string | null;
  title: string;
  authors: string[];
  year?: number | string;
  doi?: string;
  arxivId?: string;
  venue?: string;
  pageCount?: number;
  citationCount?: number;
  abstract?: string;
  ragDocId: string | null;
  spaceId: string;
}

export interface SpaceRecord {
  id: string;
  type: string;
  ownerUserId?: string | null;
  projectId?: string | null;
}

export interface PageLookupRecord {
  canonicalPageId: string;
  spaceId?: string | null;
  titleHint: string | null;
}
