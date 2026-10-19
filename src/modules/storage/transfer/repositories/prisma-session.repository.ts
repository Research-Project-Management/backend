import { Injectable } from '@nestjs/common';
import { UploadSession as PrismaSession } from '@prisma/client';
import { PrismaService } from '@/core';
import { UploadSession, UploadSessionStatus } from '../types';
import { FileScope } from '@/modules/storage/drive';

export interface IUploadSessionRepository {
  findById(id: string): Promise<UploadSession | null>;
  create(session: UploadSession): Promise<UploadSession>;
  update(session: UploadSession): Promise<UploadSession>;
  findExpiredSessions(threshold: Date, limit: number): Promise<UploadSession[]>;
}

export class UploadSessionMapper {
  public static toDomain(record: PrismaSession): UploadSession {
    return new UploadSession({
      id: record.id,
      projectId: record.projectId,
      userId: record.userId,
      s3UploadId: record.s3UploadId,
      s3Key: record.s3Key,
      filename: record.filename,
      mimeType: record.mimeType,
      totalSize: record.totalSize,
      partSize: record.partSize,
      totalParts: record.totalParts,
      expectedHash: record.expectedHash
        ? Buffer.from(record.expectedHash)
        : null,
      parentId: record.parentId,
      scope: record.projectId ? FileScope.Project : FileScope.Personal,
      status: record.status as UploadSessionStatus,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  public static toPrismaCreate(session: UploadSession) {
    return {
      id: session.id,
      projectId: session.projectId,
      userId: session.userId,
      s3UploadId: session.s3UploadId,
      s3Key: session.s3Key,
      filename: session.filename,
      mimeType: session.mimeType,
      totalSize: session.totalSize,
      partSize: session.partSize,
      totalParts: session.totalParts,
      expectedHash: session.expectedHash,
      parentId: session.parentId,
      status: session.status,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}

@Injectable()
export class PrismaUploadSessionRepository implements IUploadSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<UploadSession | null> {
    const record = await this.prisma.uploadSession.findUnique({
      where: { id },
    });
    return record ? UploadSessionMapper.toDomain(record) : null;
  }

  async create(session: UploadSession): Promise<UploadSession> {
    const data = UploadSessionMapper.toPrismaCreate(session);
    const created = await this.prisma.uploadSession.create({
      data: {
        ...data,
        expectedHash: session.expectedHash
          ? Uint8Array.from(session.expectedHash)
          : null,
      },
    });
    return UploadSessionMapper.toDomain(created);
  }

  async update(session: UploadSession): Promise<UploadSession> {
    const data = UploadSessionMapper.toPrismaCreate(session);
    const updated = await this.prisma.uploadSession.update({
      where: { id: session.id },
      data: {
        status: data.status,
        updatedAt: data.updatedAt,
      },
    });
    return UploadSessionMapper.toDomain(updated);
  }

  async findExpiredSessions(
    threshold: Date,
    limit: number,
  ): Promise<UploadSession[]> {
    const records = await this.prisma.uploadSession.findMany({
      where: {
        status: { in: ['INITIALIZED', 'UPLOADING'] },
        expiresAt: { lt: threshold },
      },
      take: limit,
    });
    return records.map((r) => UploadSessionMapper.toDomain(r));
  }
}
