import { Module } from '@nestjs/common';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { PageModule } from '../page/page.module';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [PageModule, AppCoreModule],
  controllers: [TemplateController],
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplateModule {}
