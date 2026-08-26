import { Injectable, Logger } from '@nestjs/common';
import { SecurityEventType } from '@prisma/client';
import { AuditRepository } from './audit.repository';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly auditRepo: AuditRepository) {}

  /**
   * Log an immutable security audit event. Non-blocking error handling to ensure
   * audit logging failures do not interrupt primary auth flows.
   */
  async log(event: {
    actorId?: string;
    eventType: SecurityEventType;
    targetType?: string;
    targetId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditRepo.logEvent(event);
    } catch (err) {
      this.logger.error(
        `Failed to record security audit log for event: ${event.eventType}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

  async getRecentAuditLogs(params: {
    actorId?: string;
    eventType?: SecurityEventType;
    limit?: number;
  }) {
    return this.auditRepo.queryEvents(params);
  }
}

// Alias for backwards compatibility
export const SecurityAuditService = AuditService;
export type SecurityAuditService = AuditService;
