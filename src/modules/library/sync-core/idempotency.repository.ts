import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { IdempotencyRecord } from '@prisma/client';

export type ClaimResult =
  | { status: 'acquired' }
  | { status: 'cached'; record: IdempotencyRecord }
  | { status: 'in_progress' }
  | { status: 'mismatch' };

@Injectable()
export class IdempotencyRepository {
  private readonly logger = new Logger(IdempotencyRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async claim(
    workspaceId: string,
    idempotencyKey: string,
    requestHash: string,
    ttlSeconds: number = 86400, // 24 hours
  ): Promise<ClaimResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId,
          idempotencyKey,
        },
      },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return { status: 'mismatch' };
      }

      if (existing.status === 'succeeded') {
        return { status: 'cached', record: existing };
      }

      if (
        existing.status === 'in_progress' &&
        existing.expiresAt > new Date()
      ) {
        return { status: 'in_progress' };
      }

      await this.prisma.idempotencyRecord.update({
        where: { id: existing.id },
        data: {
          status: 'in_progress',
          requestHash,
          expiresAt,
          statusCode: null,
          responseBody: null as any,
        },
      });

      return { status: 'acquired' };
    }

    await this.prisma.idempotencyRecord.create({
      data: {
        workspaceId,
        idempotencyKey,
        requestHash,
        status: 'in_progress',
        expiresAt,
      },
    });

    return { status: 'acquired' };
  }

  async markSucceeded(
    workspaceId: string,
    idempotencyKey: string,
    statusCode: number,
    responseBody: any,
  ): Promise<void> {
    await this.prisma.idempotencyRecord.updateMany({
      where: {
        workspaceId,
        idempotencyKey,
      },
      data: {
        status: 'succeeded',
        statusCode,
        responseBody: responseBody ?? null,
      },
    });
  }

  async markFailed(workspaceId: string, idempotencyKey: string): Promise<void> {
    await this.prisma.idempotencyRecord.updateMany({
      where: {
        workspaceId,
        idempotencyKey,
      },
      data: {
        status: 'failed',
      },
    });
  }
}
