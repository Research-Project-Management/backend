import { ProjectUpdateStatus } from '@prisma/client';

export interface ProjectStatusUpdateAuthorDto {
  id: string;
  name: string | null;
  avatar: string | null;
}

export interface ProjectStatusUpdateResponseDto {
  id: string;
  projectId: string;
  status: ProjectUpdateStatus;
  message: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  author: ProjectStatusUpdateAuthorDto;
}
