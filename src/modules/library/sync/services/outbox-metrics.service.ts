import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class OutboxMetrics {
  private readonly logger = new Logger(OutboxMetrics.name);
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  incrementCounter(name: string, value: number = 1): number {
    const next = (this.counters.get(name) || 0) + value;
    this.counters.set(name, next);
    return next;
  }

  getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  setGauge(name: string, value: number) {
    this.gauges.set(name, value);
  }

  getGauge(name: string): number {
    return this.gauges.get(name) || 0;
  }

  recordOutboxDispatch(durationMs: number, success: boolean) {
    const safeDuration = Math.max(
      0,
      Number.isFinite(durationMs) ? durationMs : 0,
    );
    this.incrementCounter('outbox.dispatch.total', 1);
    this.incrementCounter(
      success ? 'outbox.dispatch.succeeded' : 'outbox.dispatch.failed',
      1,
    );
    this.incrementCounter('outbox.dispatch.duration_ms.sum', safeDuration);
    this.setGauge('outbox.dispatch.last_duration_ms', safeDuration);
    this.setGauge('outbox.dispatch.last_timestamp_ms', Date.now());
    this.logger.debug(
      `[OutboxMetrics] Outbox dispatch executed in ${safeDuration}ms (success=${success})`,
    );
  }

  getSnapshot() {
    return {
      dispatchedTotal: this.getCounter('outbox.dispatch.total'),
      succeededTotal: this.getCounter('outbox.dispatch.succeeded'),
      failedTotal: this.getCounter('outbox.dispatch.failed'),
      totalDurationMs: this.getCounter('outbox.dispatch.duration_ms.sum'),
      lastDurationMs: this.getGauge('outbox.dispatch.last_duration_ms'),
      lastDispatchAt: this.getGauge('outbox.dispatch.last_timestamp_ms'),
    };
  }
}
