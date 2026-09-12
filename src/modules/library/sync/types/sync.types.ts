export type SyncEntityType =
  'Item' | 'Collection' | 'Attachment' | 'Note' | 'Annotation';

export interface UpsertSyncCollectionCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  name: string;
  description?: string;
  parentCollectionId?: string;
}

export interface UpsertSyncItemCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  itemId?: string;
  title: string;
  abstract?: string;
  year?: number;
  doi?: string;
  citationKey?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  itemType?: string;
  filename?: string;
  fileUrl?: string;
  tags?: string[];
  authors?: string[];
  creators?: Array<{
    creatorType?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    name?: string;
    orderIndex?: number;
  }>;
  collectionId?: string;
  collectionIds?: string[];
  editors?: string[];
  journal?: string;
  journalAbbr?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  rights?: string;
  license?: string;
  archive?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  callNumber?: string;
  language?: string;
  extraFields?: Record<string, unknown>;
  extra?: string;
}

export interface UpsertSyncAttachmentCommand {
  workspaceId: string;
  existingId?: string;
  itemId?: string;
  filename: string;
  url: string;
  mimeType: string;
  fileHash?: string;
  attachmentType?: string;
  size?: number;
}

export interface UpsertSyncNoteCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  itemId?: string;
  title: string;
  contentMd: string;
  tags?: string[];
}

export interface UpsertSyncAnnotationCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  attachmentId?: string;
  pageIndex: number;
  quoteText?: string;
  comment?: string;
  color?: string;
  type?: string;
}

export interface DeleteSyncEntityCommand {
  workspaceId: string;
  entityType: SyncEntityType;
  entityId: string;
  reason?: string;
  publishOutboxEventType?: string;
  publishOutboxPayload?: Record<string, unknown>;
}

export interface UpsertSyncEntityResult {
  id: string;
  isNew: boolean;
  version: number;
}

export type SyncDirection = 'pull' | 'push' | 'reconcile';
export type SyncStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SyncSessionResult {
  bindingId: string;
  workspaceId: string;
  direction: SyncDirection;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeleted: number;
  status: SyncStatus;
  errorMessage?: string | null;
}
