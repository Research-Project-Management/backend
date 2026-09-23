/**
 * filestore/core/adapters/database/prisma-manuscript-file.repository.ts
 * Driven Adapter implementing IManuscriptFileRepository using PostgreSQL via Prisma.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IManuscriptFileRepository } from '../../ports/manuscript-file-repository.port';
import { ManuscriptFile } from '../../domain/entities/manuscript-file.entity';
import { ManuscriptFileMapper } from './manuscript-file.mapper';

@Injectable()
export class PrismaManuscriptFileRepository extends IManuscriptFileRepository {
  private readonly logger = new Logger(PrismaManuscriptFileRepository.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  public async save(file: ManuscriptFile): Promise<ManuscriptFile> {
    const data = ManuscriptFileMapper.toPersistence(file);

    const upserted = await this.prisma.manuscriptFile.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        projectId: data.projectId,
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deleted: data.deleted,
        deletedAt: data.deletedAt,
      },
      update: {
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deleted: data.deleted,
        deletedAt: data.deletedAt,
      },
    });

    return ManuscriptFileMapper.toDomain(upserted);
  }

  public async findById(id: string): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findUnique({
      where: { id },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndId(projectId: string, id: string): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findFirst({
      where: {
        id,
        projectId,
      },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndName(projectId: string, name: string): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findFirst({
      where: {
        projectId,
        name,
        deleted: false,
      },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByHash(hash: string): Promise<ManuscriptFile[]> {
    const records = await this.prisma.manuscriptFile.findMany({
      where: {
        hash,
        deleted: false,
      },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async listByProject(projectId: string, includeDeleted = false): Promise<ManuscriptFile[]> {
    const records = await this.prisma.manuscriptFile.findMany({
      where: {
        projectId,
        ...(includeDeleted ? {} : { deleted: false }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async delete(id: string): Promise<void> {
    await this.prisma.manuscriptFile.update({
      where: { id },
      data: {
        deleted: true,
        deletedAt: new Date(),
      },
    });
  }

  public async countReferencesByHash(hash: string): Promise<number> {
    return await this.prisma.manuscriptFile.count({
      where: {
        hash,
        deleted: false,
      },
    });
  }
}
