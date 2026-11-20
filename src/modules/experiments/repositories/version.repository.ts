import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ExperimentVersion } from '../domain/version.domain';
import {
  mapVersionAuthor,
  VERSION_AUTHOR_SELECT,
  VersionMapper,
} from '../domain/experiments.mapper';

@Injectable()
export class VersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(version: ExperimentVersion): Promise<ExperimentVersion> {
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
        createdBy: { select: VERSION_AUTHOR_SELECT },
      },
    });

    return VersionMapper.toDomain(created, mapVersionAuthor(created.createdBy));
  }

  async findByFileId(fileId: string): Promise<ExperimentVersion[]> {
    const records = await this.prisma.fileVersion.findMany({
      where: { fileId },
      orderBy: { versionNumber: 'desc' },
      include: {
        blob: true,
        createdBy: { select: VERSION_AUTHOR_SELECT },
      },
    });

    return records.map((r) =>
      VersionMapper.toDomain(r, mapVersionAuthor(r.createdBy)),
    );
  }

  async findByFileAndVersion(
    fileId: string,
    versionNumber: number,
  ): Promise<ExperimentVersion | null> {
    const record = await this.prisma.fileVersion.findFirst({
      where: { fileId, versionNumber },
      include: {
        blob: true,
        createdBy: { select: VERSION_AUTHOR_SELECT },
      },
    });

    if (!record) return null;

    return VersionMapper.toDomain(record, mapVersionAuthor(record.createdBy));
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
