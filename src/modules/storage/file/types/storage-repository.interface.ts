/**
 * Storage & File Domain Repository Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { File, FileShare, Prisma } from '@prisma/client';

export const USER_MINIMAL_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type FileWithAuthor = Prisma.FileGetPayload<{
  include: {
    author: {
      select: typeof USER_MINIMAL_SELECT;
    };
    sharedWith: {
      include: {
        user: { select: typeof USER_MINIMAL_SELECT };
      };
    };
  };
}>;

export interface IFileRepository {
  findFileById(fileId: string): Promise<FileWithAuthor | null>;
  findFileByKey?(key: string): Promise<FileWithAuthor | null>;
  createFile(
    data: Prisma.FileCreateInput | Prisma.FileUncheckedCreateInput,
  ): Promise<FileWithAuthor>;
  updateFile(
    fileId: string,
    data: Prisma.FileUpdateInput | Prisma.FileUncheckedUpdateInput,
  ): Promise<FileWithAuthor>;
  trashFile(fileId: string): Promise<File>;
  restoreFile(fileId: string): Promise<File>;
  deleteFile(fileId: string): Promise<File>;
  findUserStarredFiles(userId: string): Promise<FileWithAuthor[]>;
  calculateUserStorageUsage(userId: string): Promise<number>;
  shareFile(
    fileId: string,
    userId: string,
    permission: string,
  ): Promise<FileShare>;
  unshareFile(fileId: string, userId: string): Promise<FileShare>;
  findFiles(
    where: Prisma.FileWhereInput,
    orderBy?: Prisma.FileOrderByWithRelationInput[],
    take?: number,
  ): Promise<FileWithAuthor[]>;
  findFileShares(userId: string): Promise<any[]>;
  getFileShares(fileId: string): Promise<FileShare[]>;
  findPageScope(
    pageId: string,
  ): Promise<{ id: string; projectId: string | null } | null>;
  findProjectScope(
    projectId: string,
  ): Promise<{ id: string; createdById: string } | null>;
  findProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<string | null>;
  calculateProjectStorageUsage(projectId: string): Promise<number>;
  getProjectWithHierarchy(projectId: string): Promise<any>;
}
