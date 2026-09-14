import { ProjectMemberRole, InvitationStatus } from '@prisma/client';

export interface ProjectInvitationWithDetails {
  id: string;
  projectId: string;
  email: string;
  role: ProjectMemberRole;
  tokenHash: string;
  status: InvitationStatus;
  invitedById: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  project: {
    id: string;
    name: string;
    identifier: string;
    avatar: string | null;
    description: string | null;
  };
  inviter?: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  } | null;
}
