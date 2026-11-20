import { Injectable } from '@nestjs/common';
import { FileUpload as PrismaSession } from '@prisma/client';
import { PrismaService } from '@/core';
import { UploadSessionRecord, UploadSessionStatus } from '../types/files.type';

export interface CreateUploadSessionInput {
  id: string;
  spaceId: string;
  userId: string;
  s3UploadId: string;
  s3Key: string;
  filename: string;
  mimeType: string;
  totalSize: bigint;
  partSize: number;
  expectedHashHex?: string | null;
  parentId?: string | null;
  expiresAt: Date;
}

@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toSessionRecord(record: PrismaSession): UploadSessionRecord {
    const totalParts =
      record.totalSize > 0n && record.partSize > 0
        ? Math.max(1, Math.ceil(Number(record.totalSize) / record.partSize))
        : 0;
    return {
      id: record.id,
      spaceId: record.spaceId,
      userId: record.createdById,
      s3UploadId: record.uploadId,
      s3Key: record.storageKey,
      filename: record.filename,
      mimeType: record.mimeType,
      totalSize: record.totalSize,
      partSize: record.partSize,
      totalParts,
      expectedHashHex: record.expectedHash
        ? Buffer.from(record.expectedHash).toString('hex')
        : null,
      parentId: record.parentId,
      status: record.status as UploadSessionStatus,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async findById(id: string): Promise<UploadSessionRecord | null> {
    const record = await this.prisma.fileUpload.findUnique({
      where: { id },
    });
    return record ? this.toSessionRecord(record) : null;
  }

  async create(input: CreateUploadSessionInput): Promise<UploadSessionRecord> {
    const expectedHash =
      input.expectedHashHex && /^[a-f0-9]{64}$/i.test(input.expectedHashHex)
        ? Uint8Array.from(Buffer.from(input.expectedHashHex, 'hex'))
        : null;

    const created = await this.prisma.fileUpload.create({
      data: {
        id: input.id,
        spaceId: input.spaceId || input.userId,
        createdById: input.userId,
        uploadId: input.s3UploadId,
        storageKey: input.s3Key,
        filename: input.filename,
        mimeType: input.mimeType,
        totalSize: input.totalSize,
        partSize: input.partSize,
        expectedHash,
        parentId: input.parentId ?? null,
        status: UploadSessionStatus.INITIALIZED,
        expiresAt: input.expiresAt,
      },
    });
    return this.toSessionRecord(created);
  }

  async markStatus(
    id: string,
    status: UploadSessionStatus,
  ): Promise<UploadSessionRecord> {
    const updated = await this.prisma.fileUpload.update({
      where: { id },
      data: {
        status,
        updatedAt: new Date(),
      },
    });
    return this.toSessionRecord(updated);
  }

  async markUploadingIfInitialized(sessionId: string): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE file_uploads
      SET status = 'UPLOADING'::"UploadSessionStatus",
          updated_at = NOW()
      WHERE id = ${sessionId}::uuid
        AND status = 'INITIALIZED'::"UploadSessionStatus"
    `;
    return Number(affected) > 0;
  }

  async findExpiredSessions(
    threshold: Date,
    limit: number,
  ): Promise<UploadSessionRecord[]> {
    const records = await this.prisma.fileUpload.findMany({
      where: {
        status: { in: ['INITIALIZED', 'UPLOADING'] },
        expiresAt: { lt: threshold },
      },
      take: limit,
    });
    return records.map((r) => this.toSessionRecord(r));
  }
}
