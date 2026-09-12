import { EntityType } from '@prisma/client';

export interface AttachmentItem {
  id: string;
  entityType: EntityType;
  entityId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  filename: string;
  url: string;
  storageKey?: string | null;
  size: number;
  mimeType: string;
  metadata?: Record<string, any> | null;
  authorId?: string | null;
  author?: {
    id: string;
    name: string;
    email: string | null;
    avatar: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PresignedAttachmentResponse {
  signedUrl: string;
  storageKey: string;
  fileUrl: string;
  entityType: EntityType;
  entityId: string;
}
