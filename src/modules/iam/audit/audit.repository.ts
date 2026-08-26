import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { SecurityEventType, Prisma, SecurityAuditLog } from '@prisma/client';
import { ISecurityAuditRepository } from '../types/iam-repository.interface';

@Injectable()
export class AuditRepository implements ISecurityAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async logEvent(data: {
    actorId?: string;
    eventType: SecurityEventType;
    targetType?: string;
    targetId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SecurityAuditLog> {
    return this.prisma.securityAuditLog.create({
      data: {
        actorId: data.actorId ?? null,
        eventType: data.eventType,
        targetType: data.targetType ?? null,
        targetId: data.targetId ?? null,
        ipAddress: data.ipAddress ?? null,
        userAgent: data.userAgent ?? null,
        metadata: (data.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });
  }

  async queryEvents(params: {
    actorId?: string;
    eventType?: SecurityEventType;
    targetId?: string;
    limit?: number;
    offset?: number;
  }): Promise<SecurityAuditLog[]> {
    return this.prisma.securityAuditLog.findMany({
      where: {
        ...(params.actorId ? { actorId: params.actorId } : {}),
        ...(params.eventType ? { eventType: params.eventType } : {}),
        ...(params.targetId ? { targetId: params.targetId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
    });
  }
}

// Alias for backwards compatibility
export const SecurityAuditRepository = AuditRepository;
export type SecurityAuditRepository = AuditRepository;
