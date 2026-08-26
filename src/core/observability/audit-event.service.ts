import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { BusinessAuditEvent } from './observability.types';

@Injectable()
export class AuditEventService {
  private readonly logger = new Logger(AuditEventService.name);
  private readonly recentEvents = new Map<string, BusinessAuditEvent[]>(); // workspaceId -> events

  constructor(@Optional() private readonly eventEmitter?: EventEmitter2) {}

  logAuditEvent(
    event: Omit<BusinessAuditEvent, 'id' | 'timestamp'>,
  ): BusinessAuditEvent {
    const fullEvent: BusinessAuditEvent = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };

    const list = this.recentEvents.get(event.workspaceId) || [];
    list.unshift(fullEvent);

    if (list.length > 2000) {
      list.pop();
    }
    this.recentEvents.set(event.workspaceId, list);

    this.logger.log(
      `[AUDIT] user=${event.userId} action=${event.action} target=${event.targetType}:${event.targetId} ws=${event.workspaceId}`,
    );

    // Emit event for Activity / Outbox subscribers
    if (this.eventEmitter) {
      this.eventEmitter.emit('audit.business_event', fullEvent);
    }

    return fullEvent;
  }

  getRecentAuditLogs(
    workspaceId: string,
    limit: number = 50,
  ): BusinessAuditEvent[] {
    const list = this.recentEvents.get(workspaceId) || [];
    return list.slice(0, Math.min(200, Math.max(1, limit)));
  }
}
