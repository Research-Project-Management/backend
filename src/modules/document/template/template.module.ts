import { Module } from '@nestjs/common';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { CoreModule as DocumentCoreModule } from '../core/core.module';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [DocumentCoreModule, AppCoreModule],
  controllers: [TemplateController],
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplateModule {}
