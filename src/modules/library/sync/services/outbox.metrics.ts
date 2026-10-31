import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class OutboxMetrics {
  private readonly logger = new Logger(OutboxMetrics.name);
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  incrementCounter(name: string, value: number = 1): number {
    const current = this.counters.get(name) || 0;
    const next = current + value;
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
    if (success) {
      this.incrementCounter('outbox.dispatch.succeeded', 1);
    } else {
      this.incrementCounter('outbox.dispatch.failed', 1);
    }
    this.incrementCounter('outbox.dispatch.duration_ms.sum', safeDuration);
    this.setGauge('outbox.dispatch.last_duration_ms', safeDuration);
    this.setGauge('outbox.dispatch.last_timestamp_ms', Date.now());
    this.logger.debug(
      `[OutboxMetrics] Outbox dispatch executed in ${safeDuration}ms (success=${success})`,
    );
  }

  getSnapshot(): {
    dispatchedTotal: number;
    succeededTotal: number;
    failedTotal: number;
    totalDurationMs: number;
    lastDurationMs: number;
    lastDispatchAt: number;
  } {
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
