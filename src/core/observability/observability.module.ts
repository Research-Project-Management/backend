import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { AuditEventService } from './audit-event.service';

@Module({
  providers: [MetricsService, AuditEventService],
  exports: [MetricsService, AuditEventService],
})
export class ObservabilityModule {}
