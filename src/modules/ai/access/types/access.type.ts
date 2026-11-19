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

export interface ChatTurnAccess {
  spaceId: string;
  projectId: string | null;
  canonicalPageId?: string;
  titleHint?: string | null;
  resolvedDocumentIds: string[];
  existingChat: ChatOwnershipRecord | null;
}

export interface ResolvedPaperTarget {
  title: string;
  authors: string[];
  year?: number | string;
  doi?: string;
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
