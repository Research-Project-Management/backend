/**
 * Storage & File Domain Repository Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { File, FileShare, Label, Prisma } from '@prisma/client';

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
  findWorkspaceFiles(
    workspaceId: string,
    parentId?: string | null,
    trashed?: boolean,
  ): Promise<FileWithAuthor[]>;
  findFolderTree(workspaceId: string): Promise<File[]>;
  findFileById(fileId: string): Promise<FileWithAuthor | null>;
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
  findUserStarredFiles(
    userId: string,
    workspaceId: string,
  ): Promise<FileWithAuthor[]>;
  calculateWorkspaceStorageUsage(workspaceId: string): Promise<number>;
  shareFile(
    fileId: string,
    userId: string,
    permission: string,
  ): Promise<FileShare>;
  unshareFile(fileId: string, userId: string): Promise<FileShare>;
}

export interface ILabelRepository {
  findWorkspaceLabels(workspaceId: string): Promise<Label[]>;
  findLabelById(labelId: string): Promise<Label | null>;
  createLabel(
    data: Prisma.LabelCreateInput | Prisma.LabelUncheckedCreateInput,
  ): Promise<Label>;
  updateLabel(
    labelId: string,
    data: Prisma.LabelUpdateInput | Prisma.LabelUncheckedUpdateInput,
  ): Promise<Label>;
  deleteLabel(labelId: string): Promise<Label>;
}
