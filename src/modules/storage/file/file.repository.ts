import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, FilePermission } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type FileWithAuthor = Prisma.FileGetPayload<{
  include: {
    author: {
      select: typeof USER_SELECT;
    };
  };
}>;

@Injectable()
export class FileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createFile(
    data: Prisma.FileCreateInput | Prisma.FileUncheckedCreateInput,
  ): Promise<FileWithAuthor> {
    return this.prisma.file.create({
      data: data as Prisma.FileCreateInput,
      include: {
        author: { select: USER_SELECT },
      },
    });
  }

  async findFileById(fileId: string): Promise<FileWithAuthor | null> {
    return this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        author: { select: USER_SELECT },
      },
    });
  }

  async updateFile(
    fileId: string,
    data: Prisma.FileUpdateInput | Prisma.FileUncheckedUpdateInput,
  ): Promise<FileWithAuthor> {
    return this.prisma.file.update({
      where: { id: fileId },
      data: data,
      include: {
        author: { select: USER_SELECT },
      },
    });
  }

  async deleteFile(fileId: string) {
    return this.prisma.file.delete({
      where: { id: fileId },
    });
  }

  async upsertFileShare(
    fileId: string,
    userId: string,
    permission: FilePermission | (string & {}),
  ) {
    return this.prisma.fileShare.upsert({
      where: {
        fileId_userId: {
          fileId,
          userId,
        },
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

  async getFileShares(fileId: string) {
    return this.prisma.fileShare.findMany({
      where: { fileId },
      include: {
        user: { select: { id: true, name: true, email: true, avatar: true } },
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
        author: { select: USER_SELECT },
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
            author: { select: USER_SELECT },
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

  // ── Scope Resolution (replaces direct Prisma calls in FileService) ──────────

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
