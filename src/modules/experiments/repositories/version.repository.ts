import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ExperimentVersion } from '../domain/version.domain';
import {
  mapVersionAuthor,
  VERSION_AUTHOR_SELECT,
  VersionMapper,
} from '../domain/experiments.mapper';

export interface IVersionRepository {
  create(version: ExperimentVersion): Promise<ExperimentVersion>;
  findByFileId(fileId: string): Promise<ExperimentVersion[]>;
  findByFileAndVersion(
    fileId: string,
    versionNumber: number,
  ): Promise<ExperimentVersion | null>;
  getLatestVersionNumber(fileId: string): Promise<number>;
  deleteByFileId(fileId: string): Promise<void>;
}

@Injectable()
export class VersionRepository implements IVersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(version: ExperimentVersion): Promise<ExperimentVersion> {
    const created = await this.prisma.storageFileVersion.create({
      data: {
        id: version.id,
        fileId: version.fileId,
        blobId: version.blobId,
        versionNumber: version.versionNumber,
        sizeBytes: version.sizeBytes,
        mimeType: version.mimeType,
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
      select: VERSION_AUTHOR_SELECT,
    });

    return VersionMapper.toDomain(created, mapVersionAuthor(user));
  }

  async findByFileId(fileId: string): Promise<ExperimentVersion[]> {
    const records = await this.prisma.storageFileVersion.findMany({
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
      select: VERSION_AUTHOR_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, mapVersionAuthor(u)]));

    return records.map((r) =>
      VersionMapper.toDomain(r, userMap.get(r.createdById) || null),
    );
  }

  async findByFileAndVersion(
    fileId: string,
    versionNumber: number,
  ): Promise<ExperimentVersion | null> {
    const record = await this.prisma.storageFileVersion.findFirst({
      where: { fileId, versionNumber },
      include: {
        blob: true,
      },
    });

    if (!record) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: record.createdById },
      select: VERSION_AUTHOR_SELECT,
    });

    return VersionMapper.toDomain(record, mapVersionAuthor(user));
  }

  async getLatestVersionNumber(fileId: string): Promise<number> {
    const latest = await this.prisma.storageFileVersion.findFirst({
      where: { fileId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });

    return latest ? latest.versionNumber : 0;
  }

  async deleteByFileId(fileId: string): Promise<void> {
    await this.prisma.storageFileVersion.deleteMany({
      where: { fileId },
    });
  }
}
