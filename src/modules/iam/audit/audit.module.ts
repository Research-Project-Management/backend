import { Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

@Module({
  providers: [AuditRepository, AuditService],
  exports: [AuditRepository, AuditService],
})
export class AuditModule {}

// Alias for backwards compatibility
export const SecurityAuditModule = AuditModule;
export type SecurityAuditModule = AuditModule;
