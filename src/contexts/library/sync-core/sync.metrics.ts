import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SyncMetricsService {
  private readonly logger = new Logger(SyncMetricsService.name);

  recordSyncPull(workspaceId: string, durationMs: number, changeCount: number) {
    this.logger.debug(
      `[SyncMetrics] Pull executed for workspace ${workspaceId}: ${changeCount} changes in ${durationMs}ms`,
    );
  }

  recordOutboxDispatch(durationMs: number, success: boolean) {
    this.logger.debug(
      `[SyncMetrics] Outbox dispatch executed in ${durationMs}ms (success=${success})`,
    );
  }

  redactSensitiveData(payload: Record<string, any>): Record<string, any> {
    if (!payload || typeof payload !== 'object') return payload;

    const sanitized = { ...payload };
    const sensitiveKeys = [
      'password',
      'token',
      'authorization',
      'apiKey',
      'secret',
    ];

    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        sanitized[key] = '[REDACTED]';
      } else if (
        typeof sanitized[key] === 'object' &&
        sanitized[key] !== null
      ) {
        sanitized[key] = this.redactSensitiveData(sanitized[key]);
      }
    }

    return sanitized;
  }
}
