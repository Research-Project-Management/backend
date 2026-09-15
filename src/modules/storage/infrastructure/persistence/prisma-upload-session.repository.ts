import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IUploadSessionRepository } from '../../domain/ports/upload-session.repository.port';
import { UploadSession } from '../../domain/entities/upload-session.entity';
import { CompletedPart } from '../../domain/ports/storage-driver.port';
import { UploadSessionMapper } from './mappers/upload-session.mapper';

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

  async delete(id: string): Promise<void> {
    await this.prisma.uploadSession.delete({
      where: { id },
    });
  }

  async recordPart(
    sessionId: string,
    partNumber: number,
    etag: string,
    sizeBytes: number,
  ): Promise<void> {
    await this.prisma.uploadPart.upsert({
      where: {
        sessionId_partNumber: { sessionId, partNumber },
      },
      create: {
        sessionId,
        partNumber,
        etag,
        sizeBytes,
      },
      update: {
        etag,
        sizeBytes,
      },
    });
  }

  async getParts(sessionId: string): Promise<CompletedPart[]> {
    const records = await this.prisma.uploadPart.findMany({
      where: { sessionId },
      orderBy: { partNumber: 'asc' },
    });
    return records.map((p) => ({
      partNumber: p.partNumber,
      eTag: p.etag,
      etag: p.etag,
    }));
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
    return records.map(UploadSessionMapper.toDomain);
  }
}
