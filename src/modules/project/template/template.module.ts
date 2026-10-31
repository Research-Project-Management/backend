import { Module } from '@nestjs/common';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { TemplateRepository } from './template.repository';
import { CoreModule } from '../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [TemplateController],
  providers: [TemplateService, TemplateRepository],
  exports: [TemplateService, TemplateRepository],
})
export class TemplateModule {}
