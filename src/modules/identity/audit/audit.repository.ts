import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, AuditOutcome, AuditSeverity } from '@prisma/client';
import { AuditLogRecordInput } from './types/audit.type';

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists an immutable enterprise audit log record to PostgreSQL.
   */
  async createEvent(event: AuditLogRecordInput) {
    return this.prisma.auditLog.create({
      data: {
        actorId: event.actorId ?? null,
        impersonatorId: event.impersonatorId ?? null,
        action: event.action,
        outcome: event.outcome ?? AuditOutcome.success,
        severity: event.severity ?? AuditSeverity.info,
        projectId: event.projectId ?? null,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
        traceId: event.traceId ?? null,
        metadata: (event.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });
  }

  /**
   * Counts events of a given action from an IP within a time window.
   * Hits the composite index: [ipAddress, action, occurredAt(sort: Desc)].
   * Useful for internal brute-force / anomaly detection.
   */
  async countRecentByIpAndAction(
    ipAddress: string,
    action: string,
    since: Date,
  ): Promise<number> {
    return this.prisma.auditLog.count({
      where: {
        ipAddress,
        action,
        occurredAt: { gte: since },
      },
    });
  }

  /**
   * Backward-compatibility alias for previous caller.
   */
  async countRecentByIpAndType(
    ipAddress: string,
    action: string,
    since: Date,
  ): Promise<number> {
    return this.countRecentByIpAndAction(ipAddress, action, since);
  }
}
