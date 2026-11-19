import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { UploadSession } from '../domain/session.domain';
import { SessionMapper } from '../domain/files.mapper';

export interface ISessionRepository {
  findById(id: string): Promise<UploadSession | null>;
  create(session: UploadSession): Promise<UploadSession>;
  update(session: UploadSession): Promise<UploadSession>;
  findExpiredSessions(threshold: Date, limit: number): Promise<UploadSession[]>;
}

@Injectable()
export class SessionRepository implements ISessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<UploadSession | null> {
    const record = await this.prisma.uploadSession.findUnique({
      where: { id },
    });
    return record ? SessionMapper.toDomain(record) : null;
  }

  async create(session: UploadSession): Promise<UploadSession> {
    const data = SessionMapper.toPrismaCreate(session);
    const created = await this.prisma.uploadSession.create({
      data: {
        ...data,
        expectedHash: session.expectedHash
          ? Uint8Array.from(session.expectedHash)
          : null,
      },
    });
    return SessionMapper.toDomain(created);
  }

  async update(session: UploadSession): Promise<UploadSession> {
    const data = SessionMapper.toPrismaCreate(session);
    const updated = await this.prisma.uploadSession.update({
      where: { id: session.id },
      data: {
        status: data.status,
        updatedAt: data.updatedAt,
      },
    });
    return SessionMapper.toDomain(updated);
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
    return records.map((r) => SessionMapper.toDomain(r));
  }
}
