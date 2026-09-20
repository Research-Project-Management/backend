import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IStorageVersionRepository } from '../../domain/ports/storage-version.repository.port';
import {
  StorageVersion,
  StorageVersionAuthor,
} from '../../domain/entities/storage-version.entity';

const AUTHOR_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

function mapAuthor(user: {
  id: string;
  email: string | null;
  profile?: { name: string; avatar: string | null } | null;
} | null): StorageVersionAuthor | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.profile?.name ?? 'User',
    avatar: user.profile?.avatar ?? null,
  };
}

@Injectable()
export class PrismaStorageVersionRepository implements IStorageVersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(version: StorageVersion): Promise<StorageVersion> {
    const created = await this.prisma.fileVersion.create({
      data: {
        id: version.id,
        fileId: version.fileId,
        blobId: version.blobId,
        versionNumber: version.versionNumber,
        changeComment: version.changeComment,
        createdById: version.createdById,
        createdAt: version.createdAt,
      },
      include: {
        blob: true,
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: created.createdById },
      select: AUTHOR_SELECT,
    });

    return new StorageVersion({
      id: created.id,
      fileId: created.fileId,
      blobId: created.blobId,
      versionNumber: created.versionNumber,
      changeComment: created.changeComment,
      createdById: created.createdById,
      createdAt: created.createdAt,
      sizeBytes: created.blob?.sizeBytes ?? 0n,
      author: mapAuthor(user),
    });
  }

  async findByFileId(fileId: string): Promise<StorageVersion[]> {
    const records = await this.prisma.fileVersion.findMany({
      where: { fileId },
      orderBy: { versionNumber: 'desc' },
      include: {
        blob: true,
      },
    });

    if (records.length === 0) return [];

    const authorIds = Array.from(new Set(records.map((r) => r.createdById)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: AUTHOR_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, mapAuthor(u)]));

    return records.map(
      (r) =>
        new StorageVersion({
          id: r.id,
          fileId: r.fileId,
          blobId: r.blobId,
          versionNumber: r.versionNumber,
          changeComment: r.changeComment,
          createdById: r.createdById,
          createdAt: r.createdAt,
          sizeBytes: r.blob?.sizeBytes ?? 0n,
          author: userMap.get(r.createdById) || null,
        }),
    );
  }

  async findByFileAndVersion(
    fileId: string,
    versionNumber: number,
  ): Promise<StorageVersion | null> {
    const record = await this.prisma.fileVersion.findFirst({
      where: { fileId, versionNumber },
      include: {
        blob: true,
      },
    });

    if (!record) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: record.createdById },
      select: AUTHOR_SELECT,
    });

    return new StorageVersion({
      id: record.id,
      fileId: record.fileId,
      blobId: record.blobId,
      versionNumber: record.versionNumber,
      changeComment: record.changeComment,
      createdById: record.createdById,
      createdAt: record.createdAt,
      sizeBytes: record.blob?.sizeBytes ?? 0n,
      author: mapAuthor(user),
    });
  }

  async getLatestVersionNumber(fileId: string): Promise<number> {
    const latest = await this.prisma.fileVersion.findFirst({
      where: { fileId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });

    return latest ? latest.versionNumber : 0;
  }

  async deleteByFileId(fileId: string): Promise<void> {
    await this.prisma.fileVersion.deleteMany({
      where: { fileId },
    });
  }
}
