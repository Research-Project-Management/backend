import { Injectable, Logger } from '@nestjs/common';
import { AuditOutcome, AuditSeverity } from '@prisma/client';
import { AuditRepository } from './audit.repository';
import { AuditLogRecordInput } from './types/audit.type';

/**
 * Enterprise Internal Audit Service (CADF / OWASP / OpenTelemetry Compliant).
 * 100% internal infrastructure telemetry:
 * - Emits structured JSON log to stdout for log shippers (Vector/Promtail/Loki/Datadog/CloudWatch).
 * - Asynchronously records immutable audit trails to PostgreSQL audit_logs table.
 * - Zero user-facing / HTTP footprint.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('SECURITY_AUDIT');

  constructor(private readonly auditRepo: AuditRepository) {}

  /**
   * Records an enterprise audit event.
   * Emits structured telemetry for log collectors and saves to database.
   * Execution is fully non-blocking and safe against persistence failures.
   */
  async record(rawEvent: AuditLogRecordInput): Promise<void> {
    const event = this.enrichEvent(rawEvent);

    this.emitInfrastructureLog(event);

    try {
      await this.auditRepo.createEvent(event);
    } catch (err) {
      this.logger.warn(
        `Failed to persist audit event [${event.action}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Internal telemetry helper to check recent failure rate (e.g. brute-force detection).
   */
  async countRecentEvents(
    ipAddress: string,
    action: string,
    windowSeconds = 300,
  ): Promise<number> {
    const since = new Date(Date.now() - windowSeconds * 1000);
    return this.auditRepo.countRecentByIpAndAction(ipAddress, action, since);
  }

  /**
   * Automatically infers outcome and severity if not explicitly provided.
   */
  private enrichEvent(event: AuditLogRecordInput): AuditLogRecordInput {
    const actionLower = event.action.toLowerCase();

    // 1. Determine Outcome
    let outcome = event.outcome;
    if (!outcome) {
      if (
        actionLower.includes('failed') ||
        actionLower.includes('breach') ||
        actionLower.includes('error')
      ) {
        outcome = AuditOutcome.failure;
      } else if (
        actionLower.includes('denied') ||
        actionLower.includes('forbidden')
      ) {
        outcome = AuditOutcome.denied;
      } else {
        outcome = AuditOutcome.success;
      }
    }

    // 2. Determine Severity
    let severity = event.severity;
    if (!severity) {
      if (actionLower.includes('breach') || actionLower.includes('attack')) {
        severity = AuditSeverity.critical;
      } else if (
        outcome === AuditOutcome.failure ||
        outcome === AuditOutcome.denied ||
        actionLower.includes('deactivated') ||
        actionLower.includes('removed') ||
        actionLower.includes('revoked')
      ) {
        severity = AuditSeverity.warning;
      } else {
        severity = AuditSeverity.info;
      }
    }

    return {
      ...event,
      outcome,
      severity,
    };
  }

  /**
   * Outputs structured JSON log for infrastructure log shippers (OpenTelemetry/W3C schema).
   */
  private emitInfrastructureLog(event: AuditLogRecordInput): void {
    const payload = JSON.stringify({
      tag: 'SECURITY_AUDIT',
      action: event.action,
      outcome: event.outcome,
      severity: event.severity,
      trace_id: event.traceId ?? undefined,
      actor: event.actorId ?? 'anonymous',
      impersonator: event.impersonatorId ?? undefined,
      project_id: event.projectId ?? undefined,
      target: event.targetType
        ? `${event.targetType}:${event.targetId ?? '*'}`
        : undefined,
      ip: event.ipAddress ?? 'unknown',
      user_agent: event.userAgent ?? undefined,
      metadata: event.metadata ?? {},
    });

    switch (event.severity) {
      case AuditSeverity.critical:
      case AuditSeverity.error:
        this.logger.error(payload);
        break;
      case AuditSeverity.warning:
        this.logger.warn(payload);
        break;
      default:
        this.logger.log(payload);
        break;
    }
  }
}
