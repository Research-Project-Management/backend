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

  async findFilesByIds(fileIds: string[]): Promise<FileWithAuthor[]> {
    return this.prisma.file.findMany({
      where: { id: { in: fileIds } },
      include: {
        author: { select: USER_SELECT },
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
}

