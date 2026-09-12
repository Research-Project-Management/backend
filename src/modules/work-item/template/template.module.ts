import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { WorkItemCoreModule } from '../core/core.module';
import { TemplateController } from './template.controller';
import { TemplateRepository } from './template.repository';
import { TemplateService } from './template.service';

@Module({
  imports: [PrismaModule, WorkItemCoreModule],
  controllers: [TemplateController],
  providers: [TemplateRepository, TemplateService],
  exports: [TemplateService, TemplateRepository],
})
export class TemplateModule {}
