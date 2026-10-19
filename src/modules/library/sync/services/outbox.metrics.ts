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
    this.logger.debug(
      `[OutboxMetrics] Outbox dispatch executed in ${durationMs}ms (success=${success})`,
    );
  }
}
