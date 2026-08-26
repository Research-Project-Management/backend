import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, FilePermission, File, FileShare } from '@prisma/client';
import {
  IFileRepository,
  FileWithAuthor,
  USER_MINIMAL_SELECT,
} from './types/storage-repository.interface';

@Injectable()
export class FileRepository implements IFileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createFile(
    data: Prisma.FileCreateInput | Prisma.FileUncheckedCreateInput,
  ): Promise<FileWithAuthor> {
    return this.prisma.file.create({
      data: data as Prisma.FileCreateInput,
      include: {
        author: { select: USER_MINIMAL_SELECT },
        sharedWith: {
          include: {
            user: { select: USER_MINIMAL_SELECT },
          },
        },
      },
    });
  }

  async findFileById(fileId: string): Promise<FileWithAuthor | null> {
    return this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        author: { select: USER_MINIMAL_SELECT },
        sharedWith: {
          include: {
            user: { select: USER_MINIMAL_SELECT },
          },
        },
      },
    });
  }

  async findWorkspaceFiles(
    workspaceId: string,
    parentId?: string | null,
    trashed = false,
  ): Promise<FileWithAuthor[]> {
    return this.prisma.file.findMany({
      where: {
        workspaceId,
        parentId: parentId === undefined ? undefined : parentId,
        trashedAt: trashed ? { not: null } : null,
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
        sharedWith: {
          include: {
            user: { select: USER_MINIMAL_SELECT },
          },
        },
      },
      orderBy: [{ isFolder: 'desc' }, { filename: 'asc' }],
    });
  }

  async findFolderTree(workspaceId: string): Promise<File[]> {
    return this.prisma.file.findMany({
      where: {
        workspaceId,
        isFolder: true,
        trashedAt: null,
      },
      orderBy: { filename: 'asc' },
    });
  }

  async updateFile(
    fileId: string,
    data: Prisma.FileUpdateInput | Prisma.FileUncheckedUpdateInput,
  ): Promise<FileWithAuthor> {
    return this.prisma.file.update({
      where: { id: fileId },
      data,
      include: {
        author: { select: USER_MINIMAL_SELECT },
        sharedWith: {
          include: {
            user: { select: USER_MINIMAL_SELECT },
          },
        },
      },
    });
  }

  async trashFile(fileId: string): Promise<File> {
    return this.prisma.file.update({
      where: { id: fileId },
      data: { trashedAt: new Date() },
    });
  }

  async restoreFile(fileId: string): Promise<File> {
    return this.prisma.file.update({
      where: { id: fileId },
      data: { trashedAt: null },
    });
  }

  async deleteFile(fileId: string): Promise<File> {
    return this.prisma.file.delete({
      where: { id: fileId },
    });
  }

  async findUserStarredFiles(
    userId: string,
    workspaceId: string,
  ): Promise<FileWithAuthor[]> {
    return this.prisma.file.findMany({
      where: {
        workspaceId,
        authorId: userId,
        starred: true,
        trashedAt: null,
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
        sharedWith: {
          include: {
            user: { select: USER_MINIMAL_SELECT },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async calculateWorkspaceStorageUsage(workspaceId: string): Promise<number> {
    const aggregate = await this.prisma.file.aggregate({
      where: {
        workspaceId,
        isFolder: false,
        trashedAt: null,
      },
      _sum: {
        size: true,
      },
    });
    return aggregate._sum.size || 0;
  }

  async shareFile(
    fileId: string,
    userId: string,
    permission: string,
  ): Promise<FileShare> {
    return this.prisma.fileShare.upsert({
      where: {
        fileId_userId: { fileId, userId },
      },
      create: {
        fileId,
        userId,
        permission: permission as FilePermission,
      },
      update: {
        permission: permission as FilePermission,
      },
    });
  }

  async unshareFile(fileId: string, userId: string): Promise<FileShare> {
    return this.prisma.fileShare.delete({
      where: {
        fileId_userId: { fileId, userId },
      },
    });
  }

  async upsertFileShare(
    fileId: string,
    userId: string,
    permission: FilePermission | (string & {}),
  ) {
    return this.shareFile(fileId, userId, permission);
  }

  async getFileShares(fileId: string) {
    return this.prisma.fileShare.findMany({
      where: { fileId },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findFiles(
    where: Prisma.FileWhereInput,
    orderBy?: Prisma.FileOrderByWithRelationInput[],
    take?: number,
  ): Promise<FileWithAuthor[]> {
    return this.prisma.file.findMany({
      where,
      include: {
        author: { select: USER_MINIMAL_SELECT },
        sharedWith: {
          include: {
            user: { select: USER_MINIMAL_SELECT },
          },
        },
      },
      orderBy,
      take,
    });
  }

  async findFileShares(userId: string) {
    return this.prisma.fileShare.findMany({
      where: { userId },
      include: {
        file: {
          include: {
            author: { select: USER_MINIMAL_SELECT },
          },
        },
      },
    });
  }

  async findFileShare(fileId: string, userId: string) {
    return this.prisma.fileShare.findUnique({
      where: {
        fileId_userId: {
          fileId,
          userId,
        },
      },
    });
  }

  async findFilesByIds(fileIds: string[]): Promise<FileWithAuthor[]> {
    return this.prisma.file.findMany({
      where: { id: { in: fileIds } },
      include: {
        author: { select: USER_MINIMAL_SELECT },
        sharedWith: {
          include: {
            user: { select: USER_MINIMAL_SELECT },
          },
        },
      },
    });
  }

  async batchUpdateFiles(
    fileIds: string[],
    data: Prisma.FileUpdateManyMutationInput,
  ) {
    return this.prisma.file.updateMany({
      where: { id: { in: fileIds } },
      data,
    });
  }

  async batchDeleteFiles(fileIds: string[]) {
    return this.prisma.file.deleteMany({
      where: { id: { in: fileIds } },
    });
  }

  // ── Scope Resolution ────────────────────────────────────────────────────────

  async findPageScope(
    pageId: string,
  ): Promise<{ projectId: string | null; workspaceId: string } | null> {
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { projectId: true, workspaceId: true },
    });
    return page ?? null;
  }

  async findProjectScope(
    projectId: string,
  ): Promise<{ workspaceId: string } | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    return project ?? null;
  }

  async findWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  async findProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    const member = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      select: { role: true },
    });
    return member?.role ?? null;
  }
}
